import fs from 'fs'
import path from 'path'
import { platform } from './platform'
import type { AgentId } from '@shared/agents/config'
import type { AgentState, NormalizedAgentEvent } from '@shared/agents/normalize'

/**
 * Mirrors the live per-node agent status to a small JSON file so an EXTERNAL reader (the
 * nodeterm mobile host agent) can render running/waiting/blocked/done badges without an IPC
 * connection into the renderer. This is a READ-ONLY side-channel: it never feeds back into the
 * app and never changes renderer behavior.
 *
 * The reduction here intentionally mirrors the renderer store `state/agentStatus.ts` for the
 * MAIN state only:
 *  - only `kind:'state'` events (which carry a `state`) move the working/waiting/blocked/done
 *    state, guarded by the same done-holdoff (a late, non-newTurn `working` must not resurrect a
 *    turn that just finished);
 *  - `kind:'session'` (start/end) resets the node to idle (state cleared), like the renderer's
 *    `setState(id, undefined)`;
 *  - `subagent-start` / `subagent-end` / `recurring` events do NOT touch the main state — they
 *    only capture identity (agentId / sessionId), exactly as the renderer routes them to the
 *    subagent / loop stores instead of `setState`.
 * `sessionId`/`agentId` are captured off any event (the renderer calls `setSessionId` on every
 * event and threads `agentId` through `setState`).
 */

// Keep in sync with the renderer store's DONE_HOLDOFF_MS: Claude runs hooks in parallel, so a
// late PostToolUse `working` POST can arrive after the `Stop` `done`. Hold `done` against any
// non-newTurn `working` for this long.
export const DONE_HOLDOFF_MS = 3000
// Drop entries whose state hasn't been refreshed in this long, so the file can't accumulate
// unbounded nodes or advertise a stale "working" from a crashed/abandoned session.
export const EXPIRE_MS = 6 * 60 * 60_000
// Coalesce bursty hook POSTs (a single turn fires many tool events) into one disk write.
export const WRITE_DEBOUNCE_MS = 300

export interface MirrorEntry {
  /** working/waiting/blocked/done; undefined = idle/unknown (e.g. after a session reset). */
  state?: AgentState
  agentId?: AgentId
  sessionId?: string
  /**
   * When the state was last asserted (freshness). Drives the done-holdoff and the expiry
   * sweep — refreshed by every state/session reduction (incl. same-state working from tool
   * events), left alone by identity-only (subagent/recurring) events and holdoff-ignored ones.
   */
  updatedAt: number
}

/** Host-level launch settings the phone consumes (spec: mobile-agent-launch-parity).
 *  Additive to MirrorFile v1 — absent on old files, ignored by old readers. */
export interface MirrorSettings {
  claudePermissionMode?: string
  /** Can `--permission-mode auto` be emitted for launches on THIS host? */
  autoSupported?: boolean
  /** Managed accounts usable on THIS host; dirs are absolute on that host. */
  claudeAccounts?: { id: string; dir: string }[]
}

export interface MirrorFile {
  v: 1
  updatedAt: number
  nodes: Record<string, { state?: AgentState; agentId?: AgentId; sessionId?: string; updatedAt: number }>
  /** Host-level launch settings (permission mode, managed accounts). Additive/optional: absent
   *  on old files and whenever no settings provider is wired — the file shape is then byte-for-byte
   *  identical to before this block existed. */
  settings?: MirrorSettings
}

/**
 * Pure reducer: fold one event into a node's entry, mirroring the renderer store's MAIN-state
 * semantics. Returns the next entry (never mutates `prev`). `now` is injected for testability.
 */
export function reduceEntry(
  prev: MirrorEntry | undefined,
  ev: NormalizedAgentEvent,
  now: number
): MirrorEntry {
  const next: MirrorEntry = prev ? { ...prev } : { updatedAt: now }
  // Identity is captured off ANY event (mirrors the renderer's per-event setSessionId +
  // agentId threading). agentId is always present on a NormalizedAgentEvent.
  if (ev.agentId) next.agentId = ev.agentId
  if (ev.sessionId) next.sessionId = ev.sessionId

  if (ev.kind === 'state' && ev.state) {
    // Done-holdoff: a late, non-newTurn `working` (out-of-order parallel hook, or an in-flight
    // tool POST at interrupt) must not resurrect a turn that just finished. Only a genuine new
    // turn (UserPromptSubmit) may. Leave state + updatedAt untouched so the window keeps
    // measuring from the `done`.
    const heldOff =
      ev.state === 'working' &&
      !ev.newTurn &&
      prev?.state === 'done' &&
      now - (prev.updatedAt ?? 0) < DONE_HOLDOFF_MS
    if (!heldOff) {
      next.state = ev.state
      next.updatedAt = now
    }
  } else if (ev.kind === 'session') {
    // SessionStart / SessionEnd both reset the node to idle (renderer: setState(id, undefined)).
    next.state = undefined
    next.updatedAt = now
  }
  // subagent-start / subagent-end / recurring: identity captured above, main state untouched.
  return next
}

/**
 * Restrict a mirror doc to the given node ids. Pure. Used by the SSH-host status push: each
 * connected host receives ONLY its own project's nodes — the full mirror would leak other
 * projects' node/session ids to every host the user is connected to.
 *
 * Deliberately drops the local `settings` block: a slice carries per-host settings that the SSH
 * push injects itself (Task 2 of mobile-agent-launch-parity), never this host's local block.
 */
export function filterMirrorForNodes(doc: MirrorFile, nodeIds: ReadonlySet<string>): MirrorFile {
  const nodes: MirrorFile['nodes'] = {}
  for (const [id, e] of Object.entries(doc.nodes)) if (nodeIds.has(id)) nodes[id] = e
  return { v: doc.v, updatedAt: doc.updatedAt, nodes }
}

/** Prune expired entries and shape the on-disk file. Pure; `now` injected for testability.
 *  `settings`, when given, is attached as the additive host-level block (absent otherwise, so the
 *  file shape is identical to before this block existed). */
export function buildFile(
  nodes: Record<string, MirrorEntry>,
  now: number,
  expireMs = EXPIRE_MS,
  settings?: MirrorSettings
): MirrorFile {
  const out: MirrorFile = { v: 1, updatedAt: now, nodes: {} }
  for (const [id, e] of Object.entries(nodes)) {
    if (now - e.updatedAt > expireMs) continue
    // Undefined fields drop out of JSON.stringify — an idle node keeps agentId/sessionId
    // without a `state` key.
    out.nodes[id] = { state: e.state, agentId: e.agentId, sessionId: e.sessionId, updatedAt: e.updatedAt }
  }
  if (settings) out.settings = settings
  return out
}

// ---- Stateful singleton (production side) --------------------------------------------------

const state = new Map<string, MirrorEntry>()
let targetFile: string | null = null
let writeTimer: NodeJS.Timeout | null = null
let writeSeq = 0
const flushListeners = new Set<(doc: MirrorFile) => void>()
// Supplies the host-level settings block, consulted fresh on every flush (so a mid-session
// permission-mode / account change is picked up without re-wiring). Null = no block written.
let settingsProvider: (() => MirrorSettings | undefined) | null = null

/**
 * Wire (or clear with `null`) the provider for the additive host-level settings block. Called
 * once from main on launch; absent ⇒ the mirror writes no `settings` key at all.
 */
export function setMirrorSettingsProvider(p: (() => MirrorSettings | undefined) | null): void {
  settingsProvider = p
}

/** Read the settings provider, failing open: a throwing/absent provider yields no block and must
 *  never break the flush. */
function safeSettings(): MirrorSettings | undefined {
  try {
    return settingsProvider?.() ?? undefined
  } catch {
    return undefined // provider must never break the flush
  }
}

/**
 * Subscribe to every flush's built doc (fires even when the local disk write fails — the doc is
 * the product, the file is one consumer of it). Returns an unsubscribe. Feeds the SSH-host
 * status push, which mirrors each connected project's slice of this doc onto its host.
 */
export function onMirrorFlush(cb: (doc: MirrorFile) => void): () => void {
  flushListeners.add(cb)
  return () => flushListeners.delete(cb)
}

/**
 * Point the mirror at its file. Called once from main on launch; the path defaults to
 * `<userData>/agent-status.json`. Tests pass an explicit path (and thus never touch electron).
 */
export function initAgentStatusMirror(filePath?: string): void {
  targetFile = filePath ?? path.join(platform().userDataDir, 'agent-status.json')
}

function resolveFile(): string | null {
  if (targetFile) return targetFile
  try {
    targetFile = path.join(platform().userDataDir, 'agent-status.json')
    return targetFile
  } catch {
    return null
  }
}

/** Fold a normalized agent event into the mirror and schedule a debounced write. */
export function recordAgentEvent(ev: NormalizedAgentEvent): void {
  if (!ev?.nodeId) return
  state.set(ev.nodeId, reduceEntry(state.get(ev.nodeId), ev, Date.now()))
  scheduleWrite()
}

/** Remove a node (call on permanent destroy). Schedules a write so the file drops it. */
export function clearNode(nodeId: string): void {
  if (state.delete(nodeId)) scheduleWrite()
}

function scheduleWrite(): void {
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    void flush()
  }, WRITE_DEBOUNCE_MS)
  // Never let the mirror keep the app alive on quit.
  writeTimer.unref?.()
}

/** Prune + atomically write the file (tmp + rename, mode 0600). Best-effort. */
export async function flush(): Promise<void> {
  const file = resolveFile()
  if (!file) return
  const now = Date.now()
  const doc = buildFile(Object.fromEntries(state), now, undefined, safeSettings())
  // Also drop expired entries from memory so the map itself can't grow without bound.
  for (const [id, e] of state) if (now - e.updatedAt > EXPIRE_MS) state.delete(id)
  for (const cb of flushListeners) {
    try {
      cb(doc)
    } catch {
      // A listener must never break the local write (or its sibling listeners).
    }
  }
  const tmp = `${file}.${process.pid}.${++writeSeq}.tmp`
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(doc), { mode: 0o600 })
    await fs.promises.rename(tmp, file)
  } catch {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
  }
}

// ---- Test helpers --------------------------------------------------------------------------

/** Reset all module state (in-memory map + config + listeners). Test-only. */
export function _resetForTest(): void {
  state.clear()
  targetFile = null
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = null
  flushListeners.clear()
  settingsProvider = null
}

/** Snapshot the in-memory map. Test-only. */
export function _snapshot(): Record<string, MirrorEntry> {
  return Object.fromEntries(state)
}
