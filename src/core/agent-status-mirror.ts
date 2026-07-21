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
  /** Local accounts' provider rate-limit usage (spec: mobile-usage-inbox). Additive/optional —
   *  absent on old files, and dropped from SSH slices (a host answers only for its own creds). */
  usage?: MirrorUsage
  /** Agent inbox: an event feed + per-node "what it's doing right now" (spec: mobile-usage-inbox).
   *  Additive/optional. Unlike `usage`, SSH slices KEEP a filtered inbox (their own nodes only). */
  inbox?: MirrorInbox
}

// ---- Usage block (mobile-usage-inbox) ------------------------------------------------------

/** Snapshot of the shared `UsageLimit`, tolerated LOOSE on purpose: a parallel branch is
 *  generalizing that type (severity may be `string | null`, windowMinutes may appear). The mirror
 *  passes entries through verbatim — every field but `kind`/`usedPercent` is optional here, and
 *  the defensive mapper below (`?? null`) compiles against either shape of the source type. */
export interface MirrorUsageLimit {
  kind: string
  group?: string | null
  usedPercent: number
  severity?: string | null
  resetsAt?: number | null
  windowMinutes?: number | null
  scopeLabel?: string | null
  isActive?: boolean
}
export interface MirrorUsageAccount {
  /** null = the system `~/.claude` account. */
  accountId: string | null
  /** Account label from settings (managed accounts); null for the system account. */
  label: string | null
  email: string | null
  agentId: string
  /** 'ok' | 'unavailable' | 'error' | 'fetching' — passed through from the usage service. */
  status: string
  updatedAt: number
  limits: MirrorUsageLimit[]
}
export interface MirrorUsage {
  updatedAt: number
  /** System account first, then managed local accounts. */
  accounts: MirrorUsageAccount[]
}

/** One cached usage row from the usage service. Deliberately STRUCTURAL (not `import`ed from
 *  `@shared/types`) so this file does not couple to a `ClaudeUsage` shape a parallel branch is
 *  mid-flight editing — a real `ClaudeUsage` is assignable to this loose shape. */
export interface UsageSnapshotEntry {
  accountId: string | null
  usage: {
    email?: string | null
    updatedAt?: number
    status?: string
    limits?: ReadonlyArray<{
      kind: string
      usedPercent: number
      group?: string | null
      severity?: string | null
      resetsAt?: number | null
      windowMinutes?: number | null
      scopeLabel?: string | null
      isActive?: boolean
    }>
  }
}

/**
 * Assemble the `usage` block from the usage service's cached snapshots + the settings account
 * list (for labels). Pure. Maps each `UsageLimit` through DEFENSIVELY (`?? null`) so it compiles
 * whether the source's `severity` is `string` or `string | null`, and never re-derives severity
 * or window from the percentage — those are the provider's call (see claude-usage-map.ts).
 * Returns `undefined` when there is nothing to advertise, so the file keeps its old shape.
 */
export function buildMirrorUsage(
  snapshot: ReadonlyArray<UsageSnapshotEntry>,
  accounts: ReadonlyArray<{ id: string; label?: string | null; email?: string | null }>,
  now: number
): MirrorUsage | undefined {
  if (snapshot.length === 0) return undefined
  const byId = new Map(accounts.map((a) => [a.id, a]))
  // System account (accountId null) first, then everything else in given order.
  const ordered = [...snapshot].sort((a, b) => {
    if (a.accountId === b.accountId) return 0
    if (a.accountId === null) return -1
    if (b.accountId === null) return 1
    return 0
  })
  const mapped: MirrorUsageAccount[] = ordered.map((e) => {
    const acct = e.accountId ? byId.get(e.accountId) : undefined
    const u = e.usage
    return {
      accountId: e.accountId,
      label: acct?.label ?? null,
      email: u.email ?? acct?.email ?? null,
      agentId: 'claude',
      status: u.status ?? 'unavailable',
      updatedAt: u.updatedAt ?? now,
      limits: (u.limits ?? []).map((l) => ({
        kind: l.kind,
        group: l.group ?? null,
        usedPercent: l.usedPercent,
        // `?? null` here is the whole point: it type-checks against BOTH a `string` and a
        // `string | null` severity (the parallel branch's in-flight generalization).
        severity: l.severity ?? null,
        resetsAt: l.resetsAt ?? null,
        windowMinutes: l.windowMinutes ?? null,
        scopeLabel: l.scopeLabel ?? null,
        isActive: l.isActive ?? false
      }))
    }
  })
  const updatedAt = mapped.reduce((m, a) => Math.max(m, a.updatedAt), 0) || now
  return { updatedAt, accounts: mapped }
}

// ---- Inbox block (mobile-usage-inbox) ------------------------------------------------------

/** Feed cap — oldest events fall off the front once the array exceeds this. */
export const INBOX_EVENTS_CAP = 50
export const INBOX_TITLE_MAX = 120
export const INBOX_DETAIL_MAX = 240
export const INBOX_ACTIVITY_MAX = 80
// Question options (spec: interactive-push-live-activities): first question only, ≤4 choices,
// each label clipped to 60 chars.
export const INBOX_QUESTION_OPTIONS_MAX = 4
export const INBOX_OPTION_LABEL_MAX = 60
// Live-update `message` headline cap (needs-you / done event title).
export const LIVE_MESSAGE_MAX = 120

export interface InboxEvent {
  /** Monotonic per writer: `${ts}-${seq}`. */
  id: string
  ts: number
  nodeId: string
  agentId?: string
  sessionId?: string
  kind: 'approval' | 'question' | 'done'
  /** First line, ≤120 chars. */
  title: string
  /** ≤240 chars — lastMessage snippet. */
  detail?: string
  /** done: the user hit Esc/Ctrl-C. */
  interrupted?: boolean
  /** approval/question: the node has since left blocked/waiting (moves to the phone's archive). */
  resolved?: boolean
  /** question only: the AskUserQuestion choices (first question, ≤4 labels, each ≤60 chars) so the
   *  phone can render numbered chips / notification actions. Absent for approvals + plain questions
   *  (spec: interactive-push-live-activities). */
  options?: string[]
  /** approval only: the deterministic hook-reply ticket (docs/hook-reply-approvals.md). Present when
   *  the managed permission hook is holding open for an answer — the phone/canvas write
   *  `~/.nodeterm/pending/<pendingId>.answer` to answer it. Rides the mirror to the phone; dropped
   *  from the push-notify body (the phone re-reads the mirror before acting). Absent = legacy prompt. */
  pendingId?: string
}
export interface InboxNodeNow {
  /** ≤80 chars — "Editing foo.ts", "Running npm test", "Reading bar.ts". */
  activity?: string
  /** Raw tool name the activity came from. */
  tool?: string
  /** Context-window fill 0–100 (from context-tail), when known. */
  contextPercent?: number
  updatedAt: number
}
export interface MirrorInbox {
  /** Oldest→newest, capped at INBOX_EVENTS_CAP. */
  events: InboxEvent[]
  /** Per-node "what it's doing right now". */
  nodes: Record<string, InboxNodeNow>
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
 *
 * `usage` is likewise DROPPED (spec: mobile-usage-inbox): a remote host's account credentials
 * live on that host, so the desktop cannot answer for them — a host running nodeterm itself
 * writes its own mirror with its own usage. `inbox` is KEPT but filtered to the slice's node ids
 * (both the `events` feed and the per-node `nodes` map).
 */
export function filterMirrorForNodes(doc: MirrorFile, nodeIds: ReadonlySet<string>): MirrorFile {
  const nodes: MirrorFile['nodes'] = {}
  for (const [id, e] of Object.entries(doc.nodes)) if (nodeIds.has(id)) nodes[id] = e
  const out: MirrorFile = { v: doc.v, updatedAt: doc.updatedAt, nodes }
  if (doc.inbox) {
    const inboxNodes: Record<string, InboxNodeNow> = {}
    for (const [id, n] of Object.entries(doc.inbox.nodes)) if (nodeIds.has(id)) inboxNodes[id] = n
    out.inbox = {
      events: doc.inbox.events.filter((e) => nodeIds.has(e.nodeId)),
      nodes: inboxNodes
    }
  }
  return out
}

/** Prune expired entries and shape the on-disk file. Pure; `now` injected for testability.
 *  `settings`, when given, is attached as the additive host-level block (absent otherwise, so the
 *  file shape is identical to before this block existed). */
export function buildFile(
  nodes: Record<string, MirrorEntry>,
  now: number,
  expireMs = EXPIRE_MS,
  settings?: MirrorSettings,
  usage?: MirrorUsage,
  inbox?: MirrorInbox
): MirrorFile {
  const out: MirrorFile = { v: 1, updatedAt: now, nodes: {} }
  for (const [id, e] of Object.entries(nodes)) {
    if (now - e.updatedAt > expireMs) continue
    // Undefined fields drop out of JSON.stringify — an idle node keeps agentId/sessionId
    // without a `state` key.
    out.nodes[id] = { state: e.state, agentId: e.agentId, sessionId: e.sessionId, updatedAt: e.updatedAt }
  }
  if (settings) out.settings = settings
  if (usage) out.usage = usage
  // Only attach a non-empty inbox — an empty one would gratuitously change the old-file shape.
  if (inbox && (inbox.events.length > 0 || Object.keys(inbox.nodes).length > 0)) out.inbox = inbox
  return out
}

// ---- Inbox production (pure helpers) -------------------------------------------------------

/** Clip a string to `max`, appending an ellipsis when it had to cut. */
function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** First non-empty line of a message, trimmed and clipped. '' when absent/blank. */
export function firstLine(msg: string | undefined, max: number): string {
  if (!msg) return ''
  const line = (msg.split('\n').find((l) => l.trim()) ?? '').trim()
  return clip(line, max)
}

/** Basename of a slash- or backslash-separated path (no `path` import: works on remote paths too). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/**
 * Map a raw hook tool invocation to a human "what it's doing now" line (spec: mobile-usage-inbox).
 * Pure; clipped to INBOX_ACTIVITY_MAX. Unknown tools fall back to "Using <tool>".
 */
export function toolActivity(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  const ti = toolInput ?? {}
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  let out: string
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      out = `Editing ${basename(str(ti.file_path)) || 'file'}`
      break
    case 'NotebookEdit':
      out = `Editing ${basename(str(ti.notebook_path) || str(ti.file_path)) || 'notebook'}`
      break
    case 'Read':
      out = `Reading ${basename(str(ti.file_path) || str(ti.notebook_path)) || 'file'}`
      break
    case 'Bash': {
      const cmd = str(ti.command).replace(/\s+/g, ' ').trim()
      out = `Running ${cmd ? clip(cmd, 60) : 'command'}`
      break
    }
    case 'Grep':
    case 'Glob':
      out = `Searching ${str(ti.pattern) || '…'}`
      break
    case 'Task':
      out = `Delegating: ${str(ti.description) || str(ti.subagent_type) || '…'}`
      break
    case 'WebFetch': {
      const url = str(ti.url)
      let host = url
      try {
        host = new URL(url).host
      } catch {
        // not a parseable URL — show the raw string
      }
      out = `Fetching ${host || '…'}`
      break
    }
    case 'WebSearch':
      out = `Fetching ${str(ti.query) || '…'}`
      break
    default:
      out = `Using ${toolName}`
  }
  return clip(out, INBOX_ACTIVITY_MAX)
}

/** Newest UNRESOLVED approval/question event for a node (dedup lookup), or undefined. */
function newestUnresolved(events: ReadonlyArray<InboxEvent>, nodeId: string): InboxEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.nodeId === nodeId && !e.resolved && (e.kind === 'approval' || e.kind === 'question')) return e
  }
  return undefined
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
// Supplies the local-accounts usage block, consulted fresh on every flush (so a poll landing
// between flushes is picked up). Null = no `usage` block written (byte-identical old shape).
let usageProvider: (() => MirrorUsage | undefined) | null = null

// ---- Inbox state (feed + per-node activity) ------------------------------------------------
// The event feed is oldest→newest and capped at INBOX_EVENTS_CAP; `inboxNodes` is the per-node
// "what it's doing right now" (activity from raw tool events + context% from context-tail). Both
// ride the same single write path as the main node map — there is one debounced flush.
let inboxEvents: InboxEvent[] = []
const inboxNodes = new Map<string, InboxNodeNow>()
let inboxSeq = 0
// Fires exactly when a NEW actionable inbox event is appended: approval/question POST-DEDUP (a
// re-asserted identical prompt returns before pushInboxEvent, so it never fires twice) and `done`
// on the turn edge. This is the seam the desktop push-notify service (src/core/push-notify.ts)
// hooks — it is fed the same events the phone's Inbox feed shows. A listener must never throw into
// production; wrapped below.
const inboxActionableListeners = new Set<(e: InboxEvent) => void>()

/**
 * Subscribe to newly-appended actionable inbox events (approval/question post-dedup, done on edge).
 * Returns an unsubscribe. Additive side-channel — does not change the feed or any disk write.
 */
export function onInboxActionable(cb: (e: InboxEvent) => void): () => void {
  inboxActionableListeners.add(cb)
  return () => inboxActionableListeners.delete(cb)
}

// ---- Live-update seams (spec: interactive-push-live-activities) -----------------------------
// Two narrow side-channels feed the desktop live-update push stream (src/core/push-notify.ts
// `createLiveUpdatePush`). Neither changes the feed or any disk write.
//  - `onNodeStateChange` fires on the MAIN-state EDGES a Live Activity cares about: working start,
//    the edge INTO waiting/blocked (mapped to 'needsYou'), and the edge into done — post the same
//    done-holdoff / newTurn gating as the badge, so a held-off working never fires a spurious start.
//  - `onNodeNowChange` fires when a node's live activity line or context% changes (from
//    recordRawToolEvent / recordContextUsage); the sender coalesces these ≥20s per node.

/** A main-state edge worth a Live Activity update. `state` is the phone-facing bucket
 *  (waiting/blocked collapse to 'needsYou'); `message` is the event headline for needs-you/done. */
export interface NodeStateChange {
  nodeId: string
  agentId?: string
  sessionId?: string
  event: 'start' | 'update' | 'end'
  state: 'working' | 'needsYou' | 'done'
  /** needs-you / done headline, ≤120 chars. Absent for a plain 'start'. */
  message?: string
  /** needsYou only (spec: interactive-push-live-activities addendum): 'approval' on the edge into
   *  blocked, 'question' on the edge into waiting. Absent on working/done edges. */
  kind?: 'approval' | 'question'
  /** question needsYou only: the AskUserQuestion choices from the stash (≤4 × ≤60), so the phone
   *  can render option buttons straight from the Live Activity. Absent otherwise. */
  options?: string[]
  /** approval needsYou only: the deterministic hook-reply ticket from the just-produced approval
   *  event, letting an intent answer the held hook. Absent otherwise. */
  pendingId?: string
  ts: number
}

/** A per-node "what it's doing now" change (activity line and/or context%). */
export interface NodeNowChange {
  nodeId: string
  activity?: string
  contextPercent?: number
  ts: number
}

const nodeStateChangeListeners = new Set<(c: NodeStateChange) => void>()
const nodeNowChangeListeners = new Set<(c: NodeNowChange) => void>()

/** Subscribe to main-state edges (working start / needsYou / done). Returns an unsubscribe. */
export function onNodeStateChange(cb: (c: NodeStateChange) => void): () => void {
  nodeStateChangeListeners.add(cb)
  return () => nodeStateChangeListeners.delete(cb)
}

/** Subscribe to per-node activity/context% changes. Returns an unsubscribe. */
export function onNodeNowChange(cb: (c: NodeNowChange) => void): () => void {
  nodeNowChangeListeners.add(cb)
  return () => nodeNowChangeListeners.delete(cb)
}

function fireNodeStateChange(c: NodeStateChange): void {
  for (const cb of nodeStateChangeListeners) {
    try {
      cb(c)
    } catch {
      // A subscriber must never break production (or its siblings).
    }
  }
}

function fireNodeNowChange(c: NodeNowChange): void {
  for (const cb of nodeNowChangeListeners) {
    try {
      cb(c)
    } catch {
      // A subscriber must never break production (or its siblings).
    }
  }
}

// Per-node stash of the pending needs-you detail, set from the raw-hook seam and attached to the
// next needs-you InboxEvent for that node. Two producers feed it:
//  - an AskUserQuestion PreToolUse stashes the option labels + question text (`options`/`question`);
//  - a PermissionRequest stashes a derived "what's being approved" summary (`approval`).
// `options` (a real picker) is the QUESTION classification signal; `approval` supplies an approval
// card's title/detail. Cleared on state-leave / new turn / session boundary, and additionally
// time-guarded (STASH_MAX_AGE_MS) so a stash that was never consumed (e.g. a picker that
// auto-resolved) can't be picked up by a genuinely unrelated later needs-you in the same turn.
interface QuestionStash {
  /** AskUserQuestion picker: ≤4 labels, each ≤60 chars. Its PRESENCE marks a real question. */
  options?: string[]
  /** The first question's prompt text, clipped to INBOX_TITLE_MAX. Absent if not present/parseable. */
  question?: string
  /** PermissionRequest: the derived "what's being approved" summary (title + optional detail). */
  approval?: { title: string; detail?: string }
  /** When the AskUserQuestion PreToolUse / PermissionRequest stashed this — freshness-guard anchor. */
  at: number
}
const pendingQuestions = new Map<string, QuestionStash>()
// A stash older than this is ignored (and swept) — see the comment above.
export const STASH_MAX_AGE_MS = 5 * 60_000

/** The node's stash IFF it exists and is fresh (< STASH_MAX_AGE_MS old); a stale one is dropped. */
function freshStash(nodeId: string, now: number): QuestionStash | undefined {
  const s = pendingQuestions.get(nodeId)
  if (!s) return undefined
  if (now - s.at > STASH_MAX_AGE_MS) {
    pendingQuestions.delete(nodeId)
    return undefined
  }
  return s
}

/**
 * Extract question option labels from an AskUserQuestion `tool_input` (first question only, v1):
 * `questions[0].options[].label`, each clipped to 60 chars, ≤4 labels. Pure. FAIL-OPEN — any shape
 * mismatch (missing/empty arrays, non-string labels) yields `undefined`.
 */
export function extractQuestionOptions(
  toolInput: Record<string, unknown> | undefined
): string[] | undefined {
  try {
    const questions = (toolInput as { questions?: unknown })?.questions
    if (!Array.isArray(questions) || questions.length === 0) return undefined
    const options = (questions[0] as { options?: unknown })?.options
    if (!Array.isArray(options)) return undefined
    const labels: string[] = []
    for (const o of options) {
      const label = (o as { label?: unknown })?.label
      if (typeof label !== 'string' || !label) continue
      labels.push(clip(label, INBOX_OPTION_LABEL_MAX))
      if (labels.length >= INBOX_QUESTION_OPTIONS_MAX) break
    }
    return labels.length > 0 ? labels : undefined
  } catch {
    return undefined
  }
}

/**
 * Extract the first question's prompt text from an AskUserQuestion `tool_input`
 * (`questions[0].question`), clipped to INBOX_TITLE_MAX. Used as the question InboxEvent's title so
 * the phone shows the actual question rather than the last assistant line. Pure; FAIL-OPEN — any
 * shape mismatch (missing/non-string) yields `undefined`.
 */
export function extractQuestionText(
  toolInput: Record<string, unknown> | undefined
): string | undefined {
  try {
    const questions = (toolInput as { questions?: unknown })?.questions
    if (!Array.isArray(questions) || questions.length === 0) return undefined
    const q = (questions[0] as { question?: unknown })?.question
    if (typeof q !== 'string' || !q) return undefined
    return clip(q, INBOX_TITLE_MAX)
  } catch {
    return undefined
  }
}

/** mcp tool short name: `mcp__<server>__<tool>` → `<tool>`. Degrades gracefully on odd shapes. */
function mcpShortName(name: string): string {
  const parts = name.split('__').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : name
}

/** JSON.stringify a value, returning undefined for empty/unserializable objects. */
function safeStringify(v: unknown): string | undefined {
  try {
    const s = JSON.stringify(v)
    return s && s !== '{}' && s !== 'null' ? s : undefined
  } catch {
    return undefined
  }
}

/**
 * Derive a human "what is being approved" summary from a PermissionRequest's tool_name/tool_input
 * (field report: approval cards showed only "Needs approval"). Pure; FAIL-OPEN — an empty tool name,
 * a shape mismatch, or any throw yields `undefined`, so the caller keeps today's lastMessage/generic
 * title. `title` is clipped to INBOX_TITLE_MAX, `detail` to INBOX_DETAIL_MAX.
 */
export function buildApprovalSummary(
  toolName: string,
  toolInput: Record<string, unknown> | undefined
): { title: string; detail?: string } | undefined {
  if (!toolName) return undefined
  try {
    const ti = toolInput ?? {}
    const str = (v: unknown): string => (typeof v === 'string' ? v : '')
    // Rough line count: newlines + 1 when non-empty (the field-report spec says rough is fine).
    const lineCount = (s: string): number => (s ? s.split('\n').length : 0)
    let title: string
    let detail: string | undefined
    switch (toolName) {
      case 'Edit':
      case 'NotebookEdit': {
        const p = str(ti.file_path) || str(ti.notebook_path)
        const added = lineCount(str(ti.new_string) || str(ti.new_source))
        const removed = lineCount(str(ti.old_string) || str(ti.old_source))
        title = `Edit ${basename(p) || 'file'}`
        detail = p ? `${p} +${added} −${removed}` : undefined
        break
      }
      case 'Write': {
        const p = str(ti.file_path)
        const n = lineCount(str(ti.content))
        title = `Write ${basename(p) || 'file'}`
        detail = p ? `${p} (${n} lines)` : undefined
        break
      }
      case 'Bash': {
        const cmd = str(ti.command)
        const first = cmd.split('\n')[0] ?? ''
        title = 'Run command'
        detail = cmd.includes('\n') ? `${first} …` : first || undefined
        break
      }
      case 'Read': {
        const p = str(ti.file_path) || str(ti.notebook_path)
        title = `Read ${basename(p) || 'file'}`
        detail = p || undefined
        break
      }
      case 'WebFetch': {
        const url = str(ti.url)
        let host = url
        try {
          host = new URL(url).host
        } catch {
          // not a parseable URL — show the raw string
        }
        title = `Fetch ${host || '…'}`
        detail = url || undefined
        break
      }
      case 'WebSearch': {
        title = 'Search'
        detail = str(ti.query) || undefined
        break
      }
      case 'Task': {
        title = 'Launch subagent'
        detail = str(ti.description) || str(ti.prompt) || undefined
        break
      }
      default: {
        title = toolName.startsWith('mcp__') ? `Use ${mcpShortName(toolName)}` : `Use ${toolName}`
        detail = safeStringify(ti)
      }
    }
    const t = clip(title, INBOX_TITLE_MAX)
    if (!t) return undefined
    const d = detail ? clip(detail, INBOX_DETAIL_MAX) : undefined
    return d ? { title: t, detail: d } : { title: t }
  } catch {
    return undefined
  }
}

function pushInboxEvent(e: Omit<InboxEvent, 'id'>): void {
  const id = `${e.ts}-${++inboxSeq}`
  const full: InboxEvent = { id, ...e }
  inboxEvents.push(full)
  // Cap the feed from the front (oldest fall off).
  if (inboxEvents.length > INBOX_EVENTS_CAP) {
    inboxEvents = inboxEvents.slice(inboxEvents.length - INBOX_EVENTS_CAP)
  }
  // Notify actionable-event subscribers (only reached AFTER the dedup early-returns above it).
  for (const cb of inboxActionableListeners) {
    try {
      cb(full)
    } catch {
      // A subscriber must never break inbox production (or its siblings).
    }
  }
}

/** Mark a node's unresolved approval/question events resolved (it left blocked/waiting). */
function resolveUnresolvedFor(nodeId: string): void {
  for (const e of inboxEvents) {
    if (e.nodeId === nodeId && !e.resolved && (e.kind === 'approval' || e.kind === 'question')) {
      e.resolved = true
    }
  }
}

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
 * Wire (or clear with `null`) the provider for the additive `usage` block. Called once per shell
 * on launch; absent ⇒ the mirror writes no `usage` key. The provider is consulted fresh on every
 * flush, so a usage poll that lands between flushes is picked up without re-wiring.
 */
export function setMirrorUsageProvider(p: (() => MirrorUsage | undefined) | null): void {
  usageProvider = p
}

/** Read the usage provider, failing open (a throwing/absent provider yields no block). */
function safeUsage(): MirrorUsage | undefined {
  try {
    return usageProvider?.() ?? undefined
  } catch {
    return undefined
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

/** Fold a normalized agent event into the mirror (main state + inbox feed) and schedule a
 *  debounced write. Called with EVERY normalized event by both shells. */
export function recordAgentEvent(ev: NormalizedAgentEvent): void {
  if (!ev?.nodeId) return
  const nodeId = ev.nodeId
  const now = Date.now()
  const prev = state.get(nodeId)
  const prevState = prev?.state
  const next = reduceEntry(prev, ev, now)
  state.set(nodeId, next)
  produceInboxFromState(nodeId, ev, prevState, next.state, now)
  scheduleWrite()
}

/**
 * Inbox event production off a state transition (spec: mobile-usage-inbox). Reads the transition
 * `prevState → nextState` that `reduceEntry` just computed (so the same done-holdoff / newTurn
 * semantics gate the feed as gate the badge — no duplicate done inside a holdoff, no resurrection).
 */
function produceInboxFromState(
  nodeId: string,
  ev: NormalizedAgentEvent,
  prevState: AgentState | undefined,
  nextState: AgentState | undefined,
  now: number
): void {
  // Clear any stashed question options on a new turn or session boundary — a stale option set must
  // never attach to a later, unrelated question. (State-leave clearing is handled below.)
  if (ev.kind === 'session' || (ev.kind === 'state' && ev.state === 'working' && ev.newTurn)) {
    pendingQuestions.delete(nodeId)
  }
  // Leaving blocked/waiting (any newer, different state — incl. a session reset to idle) resolves
  // that node's pending approval/question cards; they move to the phone's archive.
  if ((prevState === 'blocked' || prevState === 'waiting') && nextState !== prevState) {
    resolveUnresolvedFor(nodeId)
    pendingQuestions.delete(nodeId)
  }
  const baseEvent = { ts: now, nodeId, agentId: ev.agentId, sessionId: ev.sessionId }
  const stateBase = { nodeId, agentId: ev.agentId, sessionId: ev.sessionId, ts: now }
  // Working START edge (fresh turn / session open): a Live Activity begins here. reduceEntry's
  // done-holdoff means a held-off late working keeps `nextState === 'done'`, so it never reaches
  // here — no spurious 'start'.
  if (nextState === 'working' && prevState !== 'working') {
    fireNodeStateChange({ ...stateBase, event: 'start', state: 'working' })
  }
  // approval/question dedup is TITLE-based (not edge-based): a re-asserted needs-you with the SAME
  // ask is a no-op, but a genuinely different ask still lands — so the guard can't be a plain
  // "same-state, skip". `done` alone is edge-guarded (one per turn).
  if (nextState === 'blocked' || nextState === 'waiting') {
    // STASH-PRIORITY CLASSIFICATION (fixes: AskUserQuestion always rendered as an approval on the
    // phone). A pending AskUserQuestion picker reaches us as a permission-style signal — a
    // PermissionRequest hook and/or a Notification `permission_prompt`, both of which normalize to
    // `blocked` — even though it is a QUESTION with options, not an approve/deny. So when a fresh
    // AskUserQuestion stash exists we produce a `question` (with its options) REGARDLESS of which
    // needs-you state the CLI signaled; without a stash we keep today's mapping (blocked→approval,
    // waiting→question).
    const stash = freshStash(nodeId, now)
    // Only a real AskUserQuestion picker (options present) forces the QUESTION classification — an
    // approval-only stash (a PermissionRequest summary) must stay an approval.
    const options = stash?.options
    const hasQuestion = !!options
    const kind: 'approval' | 'question' = hasQuestion || nextState === 'waiting' ? 'question' : 'approval'
    const approval = kind === 'approval' ? stash?.approval : undefined
    // Title precedence: the stashed summary (AskUserQuestion's own question text for a question, or
    // the PermissionRequest's "what's being approved" title for an approval) wins so the phone shows
    // the real ask; else the last assistant line, else a kind-appropriate generic.
    const title =
      (hasQuestion ? stash?.question : approval?.title) ||
      firstLine(ev.lastMessage, INBOX_TITLE_MAX) ||
      (kind === 'approval' ? 'Needs approval' : 'Waiting for input')
    // Detail (approval only — a question renders options, not a detail line). Precedence: the stashed
    // summary detail, else the lastMessage line (today's fallback). Dropped when it merely repeats the
    // title (the common no-stash case where both derive from lastMessage).
    const rawDetail =
      kind === 'approval'
        ? approval?.detail || firstLine(ev.lastMessage, INBOX_DETAIL_MAX) || undefined
        : undefined
    const detail = rawDetail && rawDetail !== title ? rawDetail : undefined
    // pendingId (the deterministic hook-reply ticket) rides ONLY an approval. A stash-question
    // suppresses it even when a PermissionRequest fired for the AskUserQuestion tool itself:
    // approve/deny on a question is wrong UX — the phone answers with digit send-keys that drive
    // the picker directly. That held PermissionRequest (if any) simply times out after 45s and the
    // picker shows anyway (acceptable). See docs/hook-reply-approvals.md.
    const pendingId = kind === 'approval' ? ev.pendingId : undefined
    // needsYou live-update on the EDGE into the needs-you state (a re-assert of the SAME state
    // keeps the activity live). Carries the classified kind + options (question) / pendingId
    // (approval) so the Live Activity renders straight from this same code path
    // (spec: interactive-push-live-activities addendum).
    // The live-update headline folds the approval detail in (so Live Activities / push alerts read
    // "Edit App.tsx — src/components/App.tsx +2 −2"); a question / detail-less approval is just the title.
    const headline = clip(detail ? `${title} — ${detail}` : title, LIVE_MESSAGE_MAX)
    if (prevState !== nextState) {
      fireNodeStateChange({
        ...stateBase,
        event: 'update',
        state: 'needsYou',
        kind,
        message: headline,
        ...(options ? { options } : {}),
        ...(pendingId ? { pendingId } : {})
      })
    }
    if (newestUnresolved(inboxEvents, nodeId)?.title === title) return
    pushInboxEvent({
      ...baseEvent,
      kind,
      title,
      ...(detail ? { detail } : {}),
      ...(options ? { options } : {}),
      ...(pendingId ? { pendingId } : {})
    })
  } else if (nextState === 'done' && prevState !== 'done') {
    // The turn ended: emit one `done` on the edge into done (reduceEntry's holdoff keeps a late
    // working from re-entering, and the normalizer collapses an Esc-spam into one done).
    const detail = firstLine(ev.lastMessage, INBOX_DETAIL_MAX) || undefined
    const title = ev.interrupted ? 'Stopped' : 'Finished'
    fireNodeStateChange({ ...stateBase, event: 'end', state: 'done', message: title })
    pushInboxEvent({
      ...baseEvent,
      kind: 'done',
      title,
      ...(detail ? { detail } : {}),
      ...(ev.interrupted ? { interrupted: true } : {})
    })
    // A finished turn is no longer "doing" anything — clear its live activity line.
    clearActivity(nodeId, now)
  }
}

/** Clear a node's live activity (keep any contextPercent). Idempotent; no-op if nothing set. */
function clearActivity(nodeId: string, now: number): void {
  const n = inboxNodes.get(nodeId)
  if (!n || n.activity === undefined) return
  inboxNodes.set(nodeId, { contextPercent: n.contextPercent, updatedAt: now })
}

/**
 * Fold a RAW hook tool event into the per-node "what it's doing now" line (spec:
 * mobile-usage-inbox). Called from the shells' `setRawListener` for claude events. PreToolUse sets
 * the activity; Stop / SessionEnd clear it. Other events are ignored. Schedules a write only when
 * the line actually changes (raw POSTs are bursty).
 */
export function recordRawToolEvent(nodeId: string, payload: Record<string, unknown>): void {
  if (!nodeId) return
  const hook = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : ''
  const now = Date.now()
  if (hook === 'PreToolUse') {
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : ''
    if (!toolName) return
    const toolInput =
      payload.tool_input && typeof payload.tool_input === 'object'
        ? (payload.tool_input as Record<string, unknown>)
        : undefined
    // AskUserQuestion: stash the choice labels + the question text so the next needs-you event +
    // push carry them and are classified as a `question` even when the CLI signals `blocked`
    // (spec: interactive-push-live-activities; fixes AskUserQuestion-as-approval). Fail-open — a
    // shape mismatch leaves no stash.
    if (toolName === 'AskUserQuestion') {
      const opts = extractQuestionOptions(toolInput)
      if (opts) pendingQuestions.set(nodeId, { options: opts, question: extractQuestionText(toolInput), at: now })
    }
    const activity = toolActivity(toolName, toolInput)
    const cur = inboxNodes.get(nodeId)
    if (cur?.activity === activity && cur?.tool === toolName) return // no change
    inboxNodes.set(nodeId, { activity, tool: toolName, contextPercent: cur?.contextPercent, updatedAt: now })
    fireNodeNowChange({ nodeId, activity, contextPercent: cur?.contextPercent, ts: now })
    scheduleWrite()
  } else if (hook === 'PermissionRequest') {
    // Stash a "what's being approved" summary derived from the tool call so the next needs-you
    // approval event/push carries a real title + detail instead of a bare "Needs approval" (field
    // report). The raw seam fires BEFORE the normalized blocked event that produces the card, so the
    // stash is ready when produceInboxFromState reads it. Fail-open — a shape mismatch leaves no
    // stash (the card falls back to lastMessage/generic). Merges onto any fresh AskUserQuestion
    // stash so its option labels (the question signal) survive; a stale one is dropped by freshStash.
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : ''
    if (!toolName) return
    const toolInput =
      payload.tool_input && typeof payload.tool_input === 'object'
        ? (payload.tool_input as Record<string, unknown>)
        : undefined
    const summary = buildApprovalSummary(toolName, toolInput)
    if (!summary) return
    const cur = freshStash(nodeId, now)
    pendingQuestions.set(nodeId, { ...(cur ?? {}), approval: summary, at: now })
  } else if (hook === 'Stop' || hook === 'SessionEnd') {
    const before = inboxNodes.get(nodeId)?.activity
    clearActivity(nodeId, now)
    if (before !== undefined) {
      fireNodeNowChange({ nodeId, activity: undefined, contextPercent: inboxNodes.get(nodeId)?.contextPercent, ts: now })
      scheduleWrite()
    }
  }
}

/**
 * Record a node's context-window fill (0–100) from the context-tail (spec: mobile-usage-inbox).
 * Called where the shells broadcast IPC.contextUpdate. Schedules a write only on change.
 */
export function recordContextUsage(nodeId: string, percent: number): void {
  if (!nodeId || typeof percent !== 'number' || !Number.isFinite(percent)) return
  const clamped = Math.min(100, Math.max(0, percent))
  const cur = inboxNodes.get(nodeId)
  if (cur?.contextPercent === clamped) return
  const now = Date.now()
  inboxNodes.set(nodeId, { activity: cur?.activity, tool: cur?.tool, contextPercent: clamped, updatedAt: now })
  fireNodeNowChange({ nodeId, activity: cur?.activity, contextPercent: clamped, ts: now })
  scheduleWrite()
}

/**
 * Remove a node (call on permanent destroy). Its `nodes` entries (main + inbox activity) drop,
 * but its inbox EVENTS stay as feed history — marked resolved so the phone archives them.
 * Schedules a write so the file reflects the removal.
 */
export function clearNode(nodeId: string): void {
  let changed = state.delete(nodeId)
  if (inboxNodes.delete(nodeId)) changed = true
  pendingQuestions.delete(nodeId)
  // History stays; unresolved cards for a gone node can never be answered → archive them.
  for (const e of inboxEvents) {
    if (e.nodeId === nodeId && !e.resolved && (e.kind === 'approval' || e.kind === 'question')) {
      e.resolved = true
      changed = true
    }
  }
  if (changed) scheduleWrite()
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
  const inbox: MirrorInbox = { events: inboxEvents, nodes: Object.fromEntries(inboxNodes) }
  const doc = buildFile(Object.fromEntries(state), now, undefined, safeSettings(), safeUsage(), inbox)
  // Also drop expired entries from memory so the map itself can't grow without bound.
  for (const [id, e] of state) if (now - e.updatedAt > EXPIRE_MS) state.delete(id)
  // Prune stale per-node activity the same way (events stay — they are capped feed history).
  for (const [id, n] of inboxNodes) if (now - n.updatedAt > EXPIRE_MS) inboxNodes.delete(id)
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

/** Reset all module state (in-memory map + config + listeners + inbox). Test-only. */
export function _resetForTest(): void {
  state.clear()
  targetFile = null
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = null
  flushListeners.clear()
  settingsProvider = null
  usageProvider = null
  inboxEvents = []
  inboxNodes.clear()
  inboxSeq = 0
  inboxActionableListeners.clear()
  nodeStateChangeListeners.clear()
  nodeNowChangeListeners.clear()
  pendingQuestions.clear()
}

/** Snapshot the in-memory map. Test-only. */
export function _snapshot(): Record<string, MirrorEntry> {
  return Object.fromEntries(state)
}

/** Snapshot the in-memory inbox. Test-only. */
export function _inboxSnapshot(): MirrorInbox {
  return { events: inboxEvents.map((e) => ({ ...e })), nodes: Object.fromEntries(inboxNodes) }
}
