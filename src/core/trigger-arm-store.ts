/**
 * MACHINE-LOCAL execution authorization for trigger nodes (issue #493) — the other half of the
 * trust model stated in @shared/trigger.
 *
 * A trigger's DEFINITION rides the git-shared `.nodeterm/project.json`; this store holds the one
 * thing that may never travel with it: this machine's consent for that definition to fire. The
 * precedent is `IndexEntryV3.localExec` / `capabilityAck` — nothing in a shared document may cause
 * execution on its own — but the record lives in its own userData file rather than the workspace
 * index because only core ever asks it (the scheduler at fire time, the arm/disarm IPC later),
 * and threading one more field through every index write/reconcile path is the duplication that
 * file warns about.
 *
 * The arm record BINDS TO CONTENT, not just to the node id: it stores `canonicalTriggerSpec` of
 * the spec that was on screen when the user armed it, and `isArmed` answers true only while the
 * node's CURRENT spec canonicalizes to the same string. Without that, "arm once" plus a later
 * `git pull` that rewrites the payload would run the new content under the old consent — the
 * exact laundering the machine-local split exists to prevent. A drifted spec reads as DISARMED
 * (`armedRecord` still returns the stale record so the UI can say "changed since armed" instead
 * of pretending nothing happened).
 *
 * Internal state is held in `Map`s and only converted to plain objects at the serialization
 * boundary: project/node ids reach `arm()` over IPC eventually, and a `__proto__` key assigned
 * into a plain object is prototype pollution — a Map key is just a key.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isSafeNodeId } from '../shared/safe-id'
import { canonicalTriggerSpec, sanitizeTriggerSpec, type TriggerSpec } from '../shared/trigger'
import { writeFileAtomic } from './fs-atomic'

const FILE_NAME = 'trigger-arms.json'

/** Canonical spec strings are bounded by the spec caps; anything past this is not one of ours. */
const SPEC_STRING_MAX = 32_768

export interface TriggerArmRecord {
  armedAt: number
  /** `canonicalTriggerSpec` of the spec the user consented to — the arm's content binding. */
  spec: string
}

interface TriggerArmFileV1 {
  version: 1
  projects: Record<string, Record<string, TriggerArmRecord>>
}

function validRecord(value: unknown): value is TriggerArmRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as TriggerArmRecord
  return (
    Number.isSafeInteger(r.armedAt) &&
    r.armedAt > 0 &&
    typeof r.spec === 'string' &&
    r.spec.length > 0 &&
    r.spec.length <= SPEC_STRING_MAX
  )
}

/** `__proto__` & co pass `isSafeNodeId`'s charset, but assigning one onto the plain object
 *  `toFile()` serializes into would SET ITS PROTOTYPE instead of writing the key — so they are
 *  refused at every entry point into the maps, not handled at the exit. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Both key alphabets: project ids are machine-minted (uuid / `project-1` / derived), node ids are
 *  tmux names — `isSafeNodeId` covers both and bounds them. */
const validKey = (key: string): boolean => isSafeNodeId(key) && !DANGEROUS_KEYS.has(key)

export class TriggerArmStore {
  private arms = new Map<string, Map<string, TriggerArmRecord>>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly userDataDir: string) {}

  private get filePath(): string {
    return path.join(this.userDataDir, FILE_NAME)
  }

  /** Tolerant: a missing, corrupt or foreign-shaped file is an EMPTY store (every trigger
   *  disarmed), never a throw — fail-closed is the safe direction for an execution consent. */
  async load(): Promise<void> {
    this.arms = new Map()
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return
    const file = parsed as TriggerArmFileV1
    if (file.version !== 1 || !file.projects || typeof file.projects !== 'object') return
    for (const [projectId, nodes] of Object.entries(file.projects)) {
      if (!validKey(projectId) || !nodes || typeof nodes !== 'object') continue
      const perNode = new Map<string, TriggerArmRecord>()
      for (const [nodeId, record] of Object.entries(nodes)) {
        if (!validKey(nodeId) || !validRecord(record)) continue
        perNode.set(nodeId, { armedAt: record.armedAt, spec: record.spec })
      }
      if (perNode.size) this.arms.set(projectId, perNode)
    }
  }

  /** The raw record (armed for SOME spec), or undefined. Lets the UI distinguish "never armed"
   *  from "armed, but the spec changed since" — `isArmed` treats both as not armed. */
  armedRecord(projectId: string, nodeId: string): TriggerArmRecord | undefined {
    return this.arms.get(projectId)?.get(nodeId)
  }

  /**
   * THE fire-time gate: armed here, for exactly this content. `current` is re-sanitized at this
   * interpolation-adjacent site (the caller's copy may have arrived over IPC or a stale in-memory
   * node — same rule as `permissionModeFlag`); a spec the schema refuses can never read as armed.
   */
  isArmed(projectId: string, nodeId: string, current: TriggerSpec): boolean {
    const record = this.arms.get(projectId)?.get(nodeId)
    if (!record) return false
    const safe = sanitizeTriggerSpec(current)
    if (!safe) return false
    return record.spec === canonicalTriggerSpec(safe)
  }

  /**
   * Record this machine's consent for `spec` on (projectId, nodeId). The spec is re-validated
   * here — the call will arrive over IPC — and an invalid spec or key records NOTHING and
   * returns false: consent for a value the schema refuses is not a thing that can exist.
   */
  async arm(projectId: string, nodeId: string, spec: TriggerSpec): Promise<boolean> {
    if (!validKey(projectId) || !validKey(nodeId)) return false
    const safe = sanitizeTriggerSpec(spec)
    if (!safe) return false
    const perNode = this.arms.get(projectId) ?? new Map<string, TriggerArmRecord>()
    perNode.set(nodeId, { armedAt: Date.now(), spec: canonicalTriggerSpec(safe) })
    this.arms.set(projectId, perNode)
    await this.persist()
    return true
  }

  async disarm(projectId: string, nodeId: string): Promise<void> {
    const perNode = this.arms.get(projectId)
    if (!perNode?.delete(nodeId)) return
    if (!perNode.size) this.arms.delete(projectId)
    await this.persist()
  }

  /** Drop arm records for projects that no longer exist (the index is forever, a canvas churns).
   *  Callers pass the live project id set; unknown-project records are consent for nothing. */
  async pruneProjects(liveProjectIds: Iterable<string>): Promise<void> {
    const live = new Set(liveProjectIds)
    let changed = false
    for (const projectId of [...this.arms.keys()]) {
      if (live.has(projectId)) continue
      this.arms.delete(projectId)
      changed = true
    }
    if (changed) await this.persist()
  }

  /** Drop arm records for nodes no longer on the project's canvas. */
  async pruneNodes(projectId: string, liveNodeIds: Iterable<string>): Promise<void> {
    const perNode = this.arms.get(projectId)
    if (!perNode) return
    const live = new Set(liveNodeIds)
    let changed = false
    for (const nodeId of [...perNode.keys()]) {
      if (live.has(nodeId)) continue
      perNode.delete(nodeId)
      changed = true
    }
    if (!changed) return
    if (!perNode.size) this.arms.delete(projectId)
    await this.persist()
  }

  private toFile(): TriggerArmFileV1 {
    const projects: Record<string, Record<string, TriggerArmRecord>> = {}
    for (const [projectId, perNode] of this.arms)
      projects[projectId] = Object.fromEntries(perNode)
    return { version: 1, projects }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.toFile())
    const run = this.writeQueue.then(async () => {
      await fs.mkdir(this.userDataDir, { recursive: true })
      await writeFileAtomic(this.filePath, snapshot, { mode: 0o600 })
    })
    // A failed write must reach the caller, but must not wedge the queue for every later write.
    this.writeQueue = run.catch(() => {})
    return run
  }
}
