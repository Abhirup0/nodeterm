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

import type { InboxEvent } from './agent-status-mirror'

const DEFAULT_API_BASE = 'https://api.nodeterm.dev'
// Batch actionable events landing close together into one POST (≤10 events/call per the contract).
const DEFAULT_BATCH_WINDOW_MS = 2000
// Per-node throttle — mirrors the local-notification throttle (5s/node): a chatty node can't
// spam pushes.
const DEFAULT_THROTTLE_MS = 5000
// Max events per POST (backend contract: events[≤10]).
const MAX_EVENTS_PER_CALL = 10
const FETCH_TIMEOUT_MS = 8000

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
    buffer.push({
      kind: e.kind,
      title: e.title,
      ...(e.detail ? { detail: e.detail } : {}),
      nodeId: e.nodeId,
      ...(e.agentId ? { agentId: e.agentId } : {}),
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
