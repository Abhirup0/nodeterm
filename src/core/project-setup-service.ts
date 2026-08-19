import { randomUUID } from 'node:crypto'
import os from 'os'
import path from 'path'
import { IPC } from '../shared/ipc'
import {
  projectTrustContent,
  resolveProjectSettings,
  type ProjectSettingsDoc,
  type ProjectSettingsSnapshot,
  type ProjectSetupConsentAnswer,
  type ProjectSetupConsentRequest,
  type ProjectSetupEvent,
  type ProjectSetupKind,
  type ProjectSetupRunResult
} from '../shared/project-settings'
import type { SshConnection } from '../shared/ssh'
import { platform } from './platform'
import { ProjectTrustStore, hashTrustContent, localTrustKey, sshTrustKey } from './project-trust-store'

/**
 * Runs a project's `setup`/`archive` script behind the trust gate.
 *
 * The load-bearing invariants:
 *  - Only a SHARED-sourced script is gated. A value the user typed into this machine's own local
 *    overlay is their own instruction and runs promptless; a value that arrived through git (or
 *    from a remote host) is hostile input until a human approves it at that location.
 *  - What is approved is the FAMILY, not the one script: the trust content covers setupScript AND
 *    archiveScript (`projectTrustContent('setup', …)`), hashed from the SHARED document alone —
 *    never the merged/effective one, or a local override could launder a shared change past the
 *    hash.
 *  - Trust is keyed by LOCATION (`localTrustKey`/`sshTrustKey`), never by project id: ids come out
 *    of an attacker-controlled `project.json` (hostile-project-json).
 *  - The answer is a trichotomy — approve / skip / nobody-answered. Only `approve` records and
 *    runs; an expired prompt is never a retroactive yes.
 *  - Prompts are serialized app-wide: one dialog at a time, so a workspace opening five projects
 *    cannot stack five modals over each other.
 *
 * Spawning itself is injected (`runLocal`/`runSsh`) — this file knows nothing about child_process
 * or ssh, which is also what makes the gate testable without a shell.
 */

/** How long an unanswered consent prompt is held before it is dismissed and reported as
 *  `unanswered` — same bound as the ssh passphrase prompt. */
export const CONSENT_EXPIRY_MS = 300_000

export interface ProjectSetupTarget {
  projectId: string
  projectName: string
  /** Local project root — the trust location, and the spawn cwd when there is no worktree. */
  rootPath: string
  /** Set for a worktree run: the worktree dir (else rootPath). */
  worktreePath?: string
  ssh?: { server: Pick<SshConnection, 'host' | 'user' | 'port' | 'identityFile'>; remoteCwd: string }
}

export type ProjectSetupRunner = (opts: {
  script: string
  cwd: string
  env: Record<string, string>
  onChunk: (text: string) => void
  signal: AbortSignal
  ssh?: ProjectSetupTarget['ssh']
}) => Promise<{ exitCode: number }>

export interface ProjectSetupDeps {
  trust: ProjectTrustStore
  /** Reads the project's settings state (shared+local) — injected so both shells reuse WorkspaceStore. */
  readSettings(projectId: string): Promise<ProjectSettingsSnapshot | null>
  runLocal?: ProjectSetupRunner
  runSsh?: ProjectSetupRunner
  now?: () => number
}

/** Single-flight identity: one live run per LOCATION per kind. Two canvas nodes pointing at the
 *  same folder are the same run, and a hostile `project.json` cannot buy a second concurrent run
 *  by renaming its project id. */
export function setupRunKey(target: ProjectSetupTarget, kind: ProjectSetupKind): string {
  return `${kind}\0${runLocationKey(target)}`
}

function runLocationKey(target: ProjectSetupTarget): string {
  return target.ssh
    ? sshTrustKey({ server: target.ssh.server, remoteCwd: target.ssh.remoteCwd })
    : localTrustKey(target.worktreePath ?? target.rootPath)
}

/** The APPROVAL location — the project root, so a per-worktree run inherits the root's approval
 *  (the settings document it executes is the root's, shared by every worktree of that repo). */
function trustKeyFor(target: ProjectSetupTarget): string {
  return target.ssh
    ? sshTrustKey({ server: target.ssh.server, remoteCwd: target.ssh.remoteCwd })
    : localTrustKey(target.rootPath)
}

/** Exactly the two fields `projectTrustContent('setup', …)` hashes, from the SHARED document — so a
 *  dialog rendering this shows the full extent of what one approval covers, and nothing else. */
function familyScripts(sharedDoc: ProjectSettingsDoc): ProjectSetupConsentRequest['scripts'] {
  const out: ProjectSetupConsentRequest['scripts'] = {}
  if (sharedDoc.setup?.setupScript !== undefined) out.setup = sharedDoc.setup.setupScript
  if (sharedDoc.setup?.archiveScript !== undefined) out.archive = sharedDoc.setup.archiveScript
  return out
}

function locationLabel(target: ProjectSetupTarget): string {
  if (target.ssh) return `${target.ssh.server.user}@${target.ssh.server.host}:${target.ssh.remoteCwd}`
  const abs = path.resolve(target.rootPath)
  const home = os.homedir()
  return home && (abs === home || abs.startsWith(home + path.sep)) ? `~${abs.slice(home.length)}` : abs
}

interface ActiveRun {
  runKey: string
  /** Unique per launch, unlike `runKey` (which is the deterministic single-flight key). Every event
   *  carries it so a client can tell this run from the PREVIOUS run of the same script. */
  runId: string
  projectId: string
  kind: ProjectSetupKind
  abort: AbortController
  seq: number
  closed: boolean
  /** The dialog this run is currently blocked on, so `cancel` can close it instead of leaving a
   *  modal up for a run that no longer exists. */
  consentRequestId?: string
}

export class ProjectSetupService {
  private readonly active = new Map<string, ActiveRun>()
  private readonly pending = new Map<string, (answer: ProjectSetupConsentAnswer | undefined) => void>()
  /** App-wide prompt queue: each ask chains onto the previous one, so only one dialog is live. */
  private consentQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ProjectSetupDeps) {}

  async run(target: ProjectSetupTarget, kind: ProjectSetupKind): Promise<ProjectSetupRunResult> {
    const snap = await this.deps.readSettings(target.projectId)
    const resolved = resolveProjectSettings(snap?.local, snap?.shared ?? undefined)
    const picked = kind === 'setup' ? resolved.setup.setupScript : resolved.setup.archiveScript
    const script = picked?.value ?? ''
    if (!script.trim()) return { status: 'skipped', reason: 'no-script' }

    const runKey = setupRunKey(target, kind)
    if (this.active.has(runKey)) return { status: 'skipped', reason: 'busy' }
    const runner = target.ssh ? this.deps.runSsh : this.deps.runLocal
    if (!runner) return { status: 'skipped', reason: 'unavailable' }

    // Claimed BEFORE the consent await on purpose: while a dialog for this location is open, a
    // second launch must be `busy`, not a second dialog asking about the same script.
    const entry: ActiveRun = { runKey, runId: randomUUID(), projectId: target.projectId, kind, abort: new AbortController(), seq: 0, closed: false }
    this.active.set(runKey, entry)
    const abandon = (reason: 'declined' | 'unanswered' | 'unavailable' | 'no-script'): ProjectSetupRunResult => {
      this.active.delete(runKey)
      return { status: 'skipped', reason }
    }

    if (picked!.source === 'shared') {
      const sharedDoc: ProjectSettingsDoc = snap?.shared ?? {}
      const content = projectTrustContent('setup', sharedDoc)
      // Unreachable by construction (a 'shared' source means the shared doc carries this script);
      // fail closed rather than run something no hash covers.
      if (content === null) return abandon('no-script')
      const hash = hashTrustContent(content)
      const key = trustKeyFor(target)
      let trusted: boolean
      try {
        trusted = await this.deps.trust.isTrusted(key, 'setup', hash)
      } catch {
        return abandon('unavailable')
      }
      if (!trusted) {
        const answer = await this.askConsent(entry, key, {
          kind,
          projectName: target.projectName,
          locationLabel: locationLabel(target),
          // The FAMILY is what gets approved, so the dialog is handed both scripts — and from the
          // shared document alone, so what it renders is exactly what the hash covers.
          scripts: familyScripts(sharedDoc)
        })
        // A cancel raised while the dialog was open already aborted this run; it must not proceed
        // on an answer (or a race with one) that arrived anyway.
        if (entry.abort.signal.aborted) return abandon('declined')
        if (answer !== 'approve') return abandon(answer === 'skip' ? 'declined' : 'unanswered')
        try {
          await this.deps.trust.record(key, 'setup', hash, new Date(this.now()).toISOString())
        } catch {
          // The approval could not be persisted, so it is not an approval — fail closed rather
          // than run on a grant that exists only in memory.
          return abandon('unavailable')
        }
      }
    }

    // Covers a cancel raised during any of the awaits above (readSettings, the trust read/write).
    if (entry.abort.signal.aborted) return abandon('declined')

    void this.execute(entry, runner, script, target)
    // `runId` travels back with the ack so the initiator can attach THIS run (not the previous run
    // of the same script, which shares `runKey`) to its own lane.
    return {
      status: 'started',
      runKey,
      runId: entry.runId,
      waitForSetup: resolved.setup.waitForSetup?.value === true
    }
  }

  /** Aborts a run — live OR still waiting at its consent dialog. `false` = nothing by that runKey
   *  exists (already finished, or never did). */
  cancel(runKey: string): boolean {
    const entry = this.active.get(runKey)
    if (!entry) return false
    entry.abort.abort()
    const requestId = entry.consentRequestId
    if (requestId) {
      // The run this dialog belonged to is gone: close it (and free the queue) rather than leave a
      // modal whose answer can no longer mean anything. Resolving the pending entry also drops it
      // from `pending`, so a late approve for it is a no-op.
      this.pending.get(requestId)?.(undefined)
      platform().broadcast(IPC.projectSetupConsentDismiss, { requestId })
    }
    return true
  }

  /** Renderer answer for a pending consent prompt. An unknown/stale requestId (expired, double
   *  submit) and an unrecognized answer are silent no-ops — never an approval. */
  submitConsent(requestId: string, answer: ProjectSetupConsentAnswer): void {
    if (answer !== 'approve' && answer !== 'skip') return
    this.pending.get(requestId)?.(answer)
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private askConsent(
    entry: ActiveRun,
    trustKey: string,
    req: Omit<ProjectSetupConsentRequest, 'requestId' | 'previouslyApproved'>
  ): Promise<ProjectSetupConsentAnswer | undefined> {
    const step = this.consentQueue.then(async () => {
      // Cancelled while queued behind another dialog — never raise one for a run that is gone.
      if (entry.abort.signal.aborted) return undefined
      // Read at PROMPT time, not at enqueue time: an earlier prompt in the queue may have just
      // recorded an approval for this same location. Dialog copy only — the grant was the
      // `isTrusted` hash comparison, which already said no.
      const previouslyApproved = !!(await this.deps.trust.getRecord(trustKey, 'setup'))
      return new Promise<ProjectSetupConsentAnswer | undefined>((resolve) => {
        const requestId = randomUUID()
        const settle = (answer: ProjectSetupConsentAnswer | undefined): void => {
          this.pending.delete(requestId)
          entry.consentRequestId = undefined
          resolve(answer)
        }
        const timer = setTimeout(() => {
          settle(undefined) // expired, NOT declined
          platform().broadcast(IPC.projectSetupConsentDismiss, { requestId })
        }, CONSENT_EXPIRY_MS)
        timer.unref?.()
        this.pending.set(requestId, (answer) => {
          clearTimeout(timer)
          settle(answer)
        })
        entry.consentRequestId = requestId
        const payload: ProjectSetupConsentRequest = { ...req, requestId, previouslyApproved }
        platform().broadcast(IPC.projectSetupConsentRequest, payload)
      })
    })
    // A rejected step must not poison the queue for every later prompt.
    this.consentQueue = step.catch(() => {})
    return step
  }

  private async execute(
    entry: ActiveRun,
    runner: ProjectSetupRunner,
    script: string,
    target: ProjectSetupTarget
  ): Promise<void> {
    // For an ssh run every path the script sees is the REMOTE one — a local Mac path in these env
    // vars would name a directory that does not exist on the host.
    const cwd = target.ssh ? target.ssh.remoteCwd : target.worktreePath ?? target.rootPath
    const rootPath = target.ssh ? target.ssh.remoteCwd : target.rootPath
    const env = {
      NODETERM_ROOT_PATH: rootPath,
      NODETERM_WORKTREE_PATH: cwd,
      NODETERM_PROJECT_NAME: target.projectName
    }
    this.emit(entry, { state: 'running' })
    let exitCode: number | undefined
    let threw = false
    try {
      const res = await runner({
        script,
        cwd,
        env,
        // Raw pass-through: the runner edge does the debouncing/capping, so nothing is coalesced
        // twice and this layer never holds output back.
        onChunk: (text) => {
          if (text) this.emit(entry, { state: 'running', chunk: text })
        },
        signal: entry.abort.signal,
        ssh: target.ssh
      })
      exitCode = res.exitCode
    } catch {
      threw = true
    } finally {
      this.active.delete(entry.runKey)
    }
    if (entry.abort.signal.aborted) this.emit(entry, { state: 'cancelled', exitCode })
    else if (threw) this.emit(entry, { state: 'failed' })
    else this.emit(entry, { state: exitCode === 0 ? 'done' : 'failed', exitCode })
    entry.closed = true
  }

  private emit(entry: ActiveRun, ev: Omit<ProjectSetupEvent, 'runKey' | 'runId' | 'kind' | 'seq'>): void {
    // A chunk arriving after the terminal event (a runner that keeps draining) would reopen a run
    // the UI has already closed out.
    if (entry.closed) return
    entry.seq += 1
    const full: ProjectSetupEvent = {
      runKey: entry.runKey,
      runId: entry.runId,
      kind: entry.kind,
      seq: entry.seq,
      ...ev
    }
    platform().broadcast(IPC.projectSetupEvent(entry.projectId), full)
  }
}
