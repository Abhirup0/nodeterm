// Desktop → paired-phone APNs push (spec: nodeterm-server/docs/specs/2026-07-19-apns-push.md,
// "Desktop (nodeterm)" section).
//
// When an agent needs approval, asks a question, or finishes a turn, a paired iPhone should get a
// real APNs push even with the app backgrounded/killed. This service is fed by the SAME seam that
// produces the mobile Inbox feed — `onInboxActionable` in `agent-status-mirror.ts` — so it fires
// exactly on approval/question (post-dedup) and done (turn edge). It batches events in a short
// window and POSTs them to the backend, which fans out to the host's relay-paired phones.
//
// It lives in `src/core` (no electron imports) behind injected deps, so it is pure + unit-testable
// and both shells can boot it. In practice only the DESKTOP shell has a standing relay host
// identity + paired-phone registry to feed it — the Server Edition has neither, so it never
// constructs this (a documented, deliberate three-surfaces degrade; see src/server/index.ts).

import type { InboxEvent, NodeStateChange, NodeNowChange } from './agent-status-mirror'

const DEFAULT_API_BASE = 'https://api.nodeterm.dev'
// Batch actionable events landing close together into one POST (≤10 events/call per the contract).
const DEFAULT_BATCH_WINDOW_MS = 2000
// Per-node throttle — mirrors the local-notification throttle (5s/node): a chatty node can't
// spam pushes.
const DEFAULT_THROTTLE_MS = 5000
// Max events per POST (backend contract: events[≤10]).
const MAX_EVENTS_PER_CALL = 10
const FETCH_TIMEOUT_MS = 8000
// Backend contract cap for the optional per-event `nodeTitle` (the node's canvas/sidebar name,
// rendered into the alert title as "<Needs you|Completed> — <nodeTitle>").
const NODE_TITLE_MAX = 80

/** The standing relay host's identity, needed for the backend's (hostDeviceId, hostId-from-pubkey)
 *  auth. `hasPairedPhone` is what makes the service live at all — no paired phone ⇒ nowhere to fan
 *  out to ⇒ inert. `null` from `getHostIdentity` (no relay host configured / key locked) is also
 *  inert. */
export interface PushHostIdentity {
  hostDeviceId: string
  hostPublicKeyB64: string
  hostLabel: string
  hasPairedPhone: boolean
}

/** The per-event body the backend `/v1/push/notify` expects (a subset of InboxEvent). */
export interface PushNotifyEvent {
  kind: 'approval' | 'question' | 'done'
  title: string
  detail?: string
  nodeId: string
  agentId?: string
  /** The node's human display title (canvas header / sessions sidebar name), clipped to 80 chars.
   *  Optional: the backend renders the alert title as "<Needs you|Completed> — <nodeTitle>" when
   *  present, and falls back to a generic title when absent. */
  nodeTitle?: string
  /** question only: the AskUserQuestion choices (≤4 labels, each ≤60 chars). The backend renders
   *  them as numbered notification actions + appends them to the body (spec:
   *  interactive-push-live-activities). Absent for approvals + plain questions. */
  options?: string[]
  ts: number
}

export interface PushNotifyDeps {
  /** Subscribe to actionable inbox events. In production this is `onInboxActionable`. */
  subscribe: (cb: (e: InboxEvent) => void) => () => void
  /** The standing relay host identity, or null when none is configured/available. */
  getHostIdentity: () => PushHostIdentity | null
  /** The `settings.mobilePushEnabled` gate (default on) — the master switch. */
  mobilePushEnabled: () => boolean
  /** The `settings.mobilePushNeedsYou` sub-gate (default on): approval + question kinds. */
  mobilePushNeedsYou: () => boolean
  /** The `settings.mobilePushDone` sub-gate (default on): the done kind. */
  mobilePushDone: () => boolean
  /** `app.isPackaged` — dev never hits the prod API unless a local base is targeted. */
  isPackaged: () => boolean
  /** Resolve a node's human display title (canvas/sidebar name) for the push `nodeTitle`. In
   *  production this is `workspaceStore.getNodeTitle`. Optional / may return undefined — the field
   *  is then simply omitted from the payload. */
  getNodeTitle?: (nodeId: string) => string | undefined
  /** Override base URL. Defaults to `env.NODETERM_API_BASE || 'https://api.nodeterm.dev'`. */
  apiBase?: string
  /** Injectable env (DNT guards + local-dev base). Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** Injectable fetch (tests mock it). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number
  batchWindowMs?: number
  throttleMs?: number
}

export interface PushNotifyHandle {
  /** Unsubscribe + cancel any pending flush. */
  stop(): void
  /** Test-only: force any buffered events to POST now. */
  _flushNow(): Promise<void>
}

/**
 * Wire the push-notify service. Subscribes to actionable inbox events, gates them (setting off /
 * no relay host / no paired phone / DNT / unpackaged all make it inert), throttles per node, and
 * batches the survivors into `POST {apiBase}/v1/push/notify`. Drops on any network error — there is
 * NO retry queue in v1. Everything is injected, so this is pure + unit-testable.
 */
export function createPushNotify(deps: PushNotifyDeps): PushNotifyHandle {
  const env = deps.env ?? process.env
  const apiBase = deps.apiBase ?? env.NODETERM_API_BASE ?? DEFAULT_API_BASE
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const batchWindowMs = deps.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS
  const throttleMs = deps.throttleMs ?? DEFAULT_THROTTLE_MS

  const buffer: PushNotifyEvent[] = []
  const lastPushAt = new Map<string, number>()
  let batchTimer: ReturnType<typeof setTimeout> | null = null

  // Same build + DO_NOT_TRACK gate as check.ts: dev never hits the prod API unless a local server
  // is targeted explicitly.
  function allowed(): boolean {
    if (env.DO_NOT_TRACK || env.NODETERM_TELEMETRY_DISABLED) return false
    if (!deps.isPackaged() && !env.NODETERM_API_BASE) return false
    return true
  }

  /** Live identity IFF the service is enabled and there's a paired phone to reach; else null. */
  function liveIdentity(): PushHostIdentity | null {
    if (!allowed()) return null
    if (!deps.mobilePushEnabled()) return null
    const id = deps.getHostIdentity()
    if (!id || !id.hasPairedPhone) return null
    return id
  }

  function scheduleFlush(): void {
    if (batchTimer) return
    batchTimer = setTimeout(() => {
      batchTimer = null
      void flush()
    }, batchWindowMs)
    batchTimer.unref?.()
  }

  /** Per-kind sub-gate: "Needs you" covers approval + question, "Completed" covers done. Both
   *  default on; the master `mobilePushEnabled` still wins (checked via liveIdentity). When both
   *  sub-gates are off the service sends nothing — the master toggle stays honest. */
  function kindAllowed(kind: InboxEvent['kind']): boolean {
    if (kind === 'done') return deps.mobilePushDone()
    // approval | question
    return deps.mobilePushNeedsYou()
  }

  function onEvent(e: InboxEvent): void {
    // Cheap gate first: if the service is inert, don't buffer anything.
    if (!liveIdentity()) return
    // Per-kind selection: drop before the throttle window is consumed, so a declined kind
    // never blocks a later accepted one on the same node.
    if (!kindAllowed(e.kind)) return
    const t = now()
    // Per-node throttle: at most one push per node per `throttleMs` (mirrors the local notify
    // throttle). Recorded at accept time — a declined event costs no throttle window.
    if (t - (lastPushAt.get(e.nodeId) ?? -Infinity) < throttleMs) return
    lastPushAt.set(e.nodeId, t)
    // Resolve the node's display title (fail-open: a throwing/absent accessor omits the field).
    let nodeTitle: string | undefined
    try {
      nodeTitle = deps.getNodeTitle?.(e.nodeId)?.slice(0, NODE_TITLE_MAX) || undefined
    } catch {
      nodeTitle = undefined
    }
    buffer.push({
      kind: e.kind,
      title: e.title,
      ...(e.detail ? { detail: e.detail } : {}),
      nodeId: e.nodeId,
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(nodeTitle ? { nodeTitle } : {}),
      ...(e.options && e.options.length > 0 ? { options: e.options } : {}),
      ts: e.ts
    })
    scheduleFlush()
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) return
    // Re-check the gate at flush: identity/setting can change during the batch window.
    const id = liveIdentity()
    if (!id) {
      buffer.length = 0
      return
    }
    const events = buffer.splice(0, MAX_EVENTS_PER_CALL)
    // More than one call's worth accumulated in the window — send the rest right after.
    if (buffer.length > 0) scheduleFlush()

    const body = {
      hostDeviceId: id.hostDeviceId,
      hostPublicKeyB64: id.hostPublicKeyB64,
      hostLabel: id.hostLabel,
      events
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      await fetchImpl(`${apiBase}/v1/push/notify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      })
    } catch {
      // Drop on any network error — v1 has no retry queue (the phone still polls the mirror).
    } finally {
      clearTimeout(timer)
    }
  }

  const unsubscribe = deps.subscribe(onEvent)

  return {
    stop() {
      unsubscribe()
      if (batchTimer) {
        clearTimeout(batchTimer)
        batchTimer = null
      }
      buffer.length = 0
    },
    _flushNow: flush
  }
}

// ---- Live-update stream (spec: interactive-push-live-activities) ----------------------------
// A second, chattier stream to `POST {apiBase}/v1/push/live-update`, feeding iOS Live Activities.
// Two sources from the mirror:
//   - STATE EDGES (`onNodeStateChange`): working start → event 'start', edge into waiting/blocked →
//     event 'update' state 'needsYou', edge into done → event 'end'. Sent IMMEDIATELY (short batch
//     window only, to coalesce simultaneous edges into one POST + honor the ≤20 cap).
//   - NOW CHANGES (`onNodeNowChange`): activity line / context% ticks, COALESCED to ≥20s per node
//     (event 'update', state 'working' — activity only moves while a turn runs).
// Same host-identity auth + DNT/packaged/paired-phone guards as notify, plus its own
// `mobileLiveActivities` sub-gate (both under the `mobilePushEnabled` master).

// Batch window for POSTing accumulated updates — short, so a state edge goes out "immediately".
const DEFAULT_LIVE_BATCH_WINDOW_MS = 1000
// Coalesce activity/context ticks to at most one live-update per node per this window.
const DEFAULT_LIVE_COALESCE_MS = 20_000
// Backend contract cap: updates[≤20] per call.
const MAX_UPDATES_PER_CALL = 20
// Live-activity field caps (Apple content-state stays small).
const LIVE_ACTIVITY_MAX = 80
const LIVE_MESSAGE_MAX = 120

/** One entry of the `/v1/push/live-update` `updates[]` array (backend contract). */
export interface LiveUpdateItem {
  nodeId: string
  nodeTitle?: string
  agentId?: string
  event: 'start' | 'update' | 'end'
  state: 'working' | 'needsYou' | 'done'
  activity?: string
  contextPercent?: number
  message?: string
  /** needsYou only (spec: interactive-push-live-activities addendum): 'approval' | 'question'.
   *  Omitted otherwise — the backend also forces null on non-needsYou content-state. */
  kind?: 'approval' | 'question'
  /** question needsYou only: the AskUserQuestion choices (≤4 × ≤60), for Live Activity buttons. */
  options?: string[]
  /** approval needsYou only: the deterministic hook-reply ticket, letting an intent answer. */
  pendingId?: string
  ts: number
}

export interface LiveUpdateDeps {
  /** Subscribe to main-state edges. In production this is `onNodeStateChange`. */
  subscribeStateChange: (cb: (c: NodeStateChange) => void) => () => void
  /** Subscribe to per-node activity/context changes. In production this is `onNodeNowChange`. */
  subscribeNowChange: (cb: (c: NodeNowChange) => void) => () => void
  /** The standing relay host identity, or null when none is configured/available. */
  getHostIdentity: () => PushHostIdentity | null
  /** The `settings.mobilePushEnabled` master switch. */
  mobilePushEnabled: () => boolean
  /** The `settings.mobileLiveActivities` sub-gate (default on). */
  mobileLiveActivities: () => boolean
  /** `app.isPackaged` — dev never hits the prod API unless a local base is targeted. */
  isPackaged: () => boolean
  /** Resolve a node's human display title. In production this is `workspaceStore.getNodeTitle`. */
  getNodeTitle?: (nodeId: string) => string | undefined
  apiBase?: string
  env?: Record<string, string | undefined>
  fetchImpl?: typeof fetch
  now?: () => number
  batchWindowMs?: number
  coalesceMs?: number
}

export interface LiveUpdateHandle {
  stop(): void
  _flushNow(): Promise<void>
}

/**
 * Wire the live-update push stream. State edges post immediately (within a short batch window);
 * activity/context ticks coalesce to ≥20s per node. Gated by the master switch, the
 * `mobileLiveActivities` sub-gate, and the same DNT/packaged/identity/paired-phone guards as
 * notify. Everything is injected — pure + unit-testable. Drops on any network error (no retry).
 */
export function createLiveUpdatePush(deps: LiveUpdateDeps): LiveUpdateHandle {
  const env = deps.env ?? process.env
  const apiBase = deps.apiBase ?? env.NODETERM_API_BASE ?? DEFAULT_API_BASE
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const batchWindowMs = deps.batchWindowMs ?? DEFAULT_LIVE_BATCH_WINDOW_MS
  const coalesceMs = deps.coalesceMs ?? DEFAULT_LIVE_COALESCE_MS

  const buffer: LiveUpdateItem[] = []
  // Per-node coalescing of activity/context ticks.
  const lastNowSentAt = new Map<string, number>()
  const pendingNow = new Map<string, NodeNowChange>()
  let batchTimer: ReturnType<typeof setTimeout> | null = null
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null

  function allowed(): boolean {
    if (env.DO_NOT_TRACK || env.NODETERM_TELEMETRY_DISABLED) return false
    if (!deps.isPackaged() && !env.NODETERM_API_BASE) return false
    return true
  }

  function liveIdentity(): PushHostIdentity | null {
    if (!allowed()) return null
    if (!deps.mobilePushEnabled()) return null
    if (!deps.mobileLiveActivities()) return null
    const id = deps.getHostIdentity()
    if (!id || !id.hasPairedPhone) return null
    return id
  }

  function nodeTitleOf(nodeId: string): string | undefined {
    try {
      return deps.getNodeTitle?.(nodeId)?.slice(0, NODE_TITLE_MAX) || undefined
    } catch {
      return undefined
    }
  }

  function scheduleFlush(): void {
    if (batchTimer) return
    batchTimer = setTimeout(() => {
      batchTimer = null
      void flush()
    }, batchWindowMs)
    batchTimer.unref?.()
  }

  function onStateChange(c: NodeStateChange): void {
    if (!liveIdentity()) return
    const title = nodeTitleOf(c.nodeId)
    // kind/options/pendingId ride only a needsYou edge (spec: interactive-push-live-activities
    // addendum) — belt-and-braces gate on state so a working/done edge never carries them (the
    // backend also nulls them on non-needsYou content-state).
    const needsYou = c.state === 'needsYou'
    buffer.push({
      nodeId: c.nodeId,
      ...(title ? { nodeTitle: title } : {}),
      ...(c.agentId ? { agentId: c.agentId } : {}),
      event: c.event,
      state: c.state,
      ...(c.message ? { message: c.message.slice(0, LIVE_MESSAGE_MAX) } : {}),
      ...(needsYou && c.kind ? { kind: c.kind } : {}),
      ...(needsYou && c.options && c.options.length > 0 ? { options: c.options } : {}),
      ...(needsYou && c.pendingId ? { pendingId: c.pendingId } : {}),
      ts: c.ts
    })
    scheduleFlush()
  }

  /** Push a coalesced now-update for a node into the buffer. */
  function emitNow(c: NodeNowChange): void {
    const title = nodeTitleOf(c.nodeId)
    buffer.push({
      nodeId: c.nodeId,
      ...(title ? { nodeTitle: title } : {}),
      event: 'update',
      state: 'working',
      ...(c.activity ? { activity: c.activity.slice(0, LIVE_ACTIVITY_MAX) } : {}),
      ...(typeof c.contextPercent === 'number' ? { contextPercent: c.contextPercent } : {}),
      ts: c.ts
    })
    scheduleFlush()
  }

  function scheduleCoalesceTimer(): void {
    if (coalesceTimer || pendingNow.size === 0) return
    // Fire at the soonest node's window edge.
    const t = now()
    let soonest = Infinity
    for (const nodeId of pendingNow.keys()) {
      const due = (lastNowSentAt.get(nodeId) ?? 0) + coalesceMs
      if (due < soonest) soonest = due
    }
    const delay = Math.max(0, soonest - t)
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null
      const cur = now()
      for (const [nodeId, change] of [...pendingNow]) {
        if (cur - (lastNowSentAt.get(nodeId) ?? -Infinity) >= coalesceMs) {
          pendingNow.delete(nodeId)
          lastNowSentAt.set(nodeId, cur)
          emitNow(change)
        }
      }
      scheduleCoalesceTimer()
    }, delay)
    coalesceTimer.unref?.()
  }

  function onNowChange(c: NodeNowChange): void {
    if (!liveIdentity()) return
    const t = now()
    const last = lastNowSentAt.get(c.nodeId) ?? -Infinity
    if (t - last >= coalesceMs) {
      // Leading edge: send now.
      lastNowSentAt.set(c.nodeId, t)
      pendingNow.delete(c.nodeId)
      emitNow(c)
    } else {
      // Within the window: keep only the latest, flush at the window edge.
      pendingNow.set(c.nodeId, c)
      scheduleCoalesceTimer()
    }
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) return
    const id = liveIdentity()
    if (!id) {
      buffer.length = 0
      return
    }
    const updates = buffer.splice(0, MAX_UPDATES_PER_CALL)
    if (buffer.length > 0) scheduleFlush()

    const body = {
      hostDeviceId: id.hostDeviceId,
      hostPublicKeyB64: id.hostPublicKeyB64,
      hostLabel: id.hostLabel,
      updates
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      await fetchImpl(`${apiBase}/v1/push/live-update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      })
    } catch {
      // Drop on any network error — no retry queue (the phone still polls the mirror).
    } finally {
      clearTimeout(timer)
    }
  }

  const unsubState = deps.subscribeStateChange(onStateChange)
  const unsubNow = deps.subscribeNowChange(onNowChange)

  return {
    stop() {
      unsubState()
      unsubNow()
      if (batchTimer) {
        clearTimeout(batchTimer)
        batchTimer = null
      }
      if (coalesceTimer) {
        clearTimeout(coalesceTimer)
        coalesceTimer = null
      }
      buffer.length = 0
      pendingNow.clear()
    },
    _flushNow: flush
  }
}
