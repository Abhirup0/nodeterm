// PresenceHub — the peer table for team presence (docs/team-presence.md).
//
// One hub, two adapters: the Server Edition joins/leaves each authenticated WebSocket
// (src/server/ws.ts), and the desktop joins its own window plus every bridged relay peer
// (src/main/index.ts, src/main/remote/standing-host.ts). The hub itself is a dumb reflector:
// it holds Map<clientId, PeerState>, applies events, and emits diffs. No electron, no ws, no
// disk, no timers — it talks to its shell only through platform() (see src/core/platform.ts).
//
// PRESENCE IS NEVER PERSISTED. Nothing here reaches workspace.json / project.json / settings.json.

import { IPC } from '../../shared/ipc'
import { platform } from '../platform'
import {
  CHAT_MAX_LEN,
  REF_MAX_LEN,
  capCodePoints,
  defaultNameFor,
  nextFreeColor,
  sanitizeIdentity,
  type ClientId,
  type PeerDiff,
  type PeerIdentity,
  type PeerState
} from '../../shared/presence'

/** A typing badge re-broadcasts at most this often per (client, node) — see noteTyping. */
export const TYPING_THROTTLE_MS = 500

/**
 * Per-(client, channel) token buckets: `perSec` is the sustained rate, `burst` the bucket size
 * (how far a client may run ahead of it). Everything the hub takes from a client fans out to every
 * peer, so an unlimited ingest is an unlimited N-way amplifier: the ~20 Hz cursor throttle lives in
 * the HONEST renderer only, and a tab that simply doesn't run it — or a scripted client on the
 * shared Server Edition password — would otherwise be free to broadcast at loop speed and fill
 * every peer's WS send buffer (the same sink pty output rides, so terminals stall behind it).
 *
 * The budgets are sized to the app's own behaviour, so a well-behaved client can never hit one:
 *   - cursor: 20/s, exactly the renderer's CURSOR_MIN_INTERVAL_MS (50 ms) throttle, with 2 s of
 *     burst for scheduling jitter,
 *   - chat: one cast per keystroke — faster than any human types,
 *   - focus: one per node hover — orders of magnitude of headroom,
 *   - project: one per tab switch. DELIBERATELY generous (see isClearingCast): a dropped project
 *     switch is not a lost frame but LOST STATE — the hub, and so every teammate's canvas, chips
 *     and facepile, would stay on the project you left, forever. A human input path cannot come
 *     near this: holding ⌘1 repeats the SAME id (the renderer dedups it, and the hub's setter
 *     ignores an unchanged value anyway), so only DISTINCT switches spend a token.
 *   - hello: sent at connect (and once more when the user names themselves).
 * Excess casts are DROPPED silently. Never disconnect: an honest client that hits a burst edge
 * (a wedged event loop suddenly flushing) would lose a frame, not its session — and the next
 * cursor sample carries the current position anyway, so a dropped one is invisible.
 */
export const PRESENCE_RATE_BUDGETS: Record<string, { perSec: number; burst: number }> = {
  [IPC.presenceCursor]: { perSec: 20, burst: 40 },
  [IPC.presenceChat]: { perSec: 25, burst: 50 },
  [IPC.presenceFocus]: { perSec: 10, burst: 20 },
  [IPC.presenceProject]: { perSec: 20, burst: 60 },
  [IPC.presenceHello]: { perSec: 2, burst: 5 }
}

/**
 * Does this cast CLEAR the client's state (a null cursor, a closed chat, a released focus)?
 *
 * Such a cast is EXEMPT from the bucket, because a bucket may only ever drop a signal whose loss
 * is self-correcting. A cursor sample is superseded by the next one, so dropping it costs a frame.
 * A clear is an EDGE: nothing supersedes it, no client acks it, nothing re-announces it — the
 * renderer has already recorded "I retracted that" (publishedRef / lastFocus) and will never send
 * it again. Drop one and the hub keeps the last value it accepted: a chat bubble pinned to a
 * teammate's cursor forever, a ghost cursor, a "who is here" chip on a node nobody is in.
 * Reachable in practice: a held key at X11's ~25/s repeat drains the chat bucket, and the keyup
 * retraction is the very next cast.
 *
 * And it CANNOT become a flood vector, by construction: the setters ignore an unchanged value, so
 * a clear broadcasts at most ONCE — re-arming it takes an intervening value cast, which IS bucketed.
 * The clears' fan-out rate is therefore bounded by the (rate-limited) value casts, not by the
 * client's send loop; an unlimited null flood is a no-op loop inside the hub.
 *
 * The predicates mirror each setter's own "is this null?" rule exactly — keep them in sync.
 */
function isClearingCast(channel: string, payload: unknown): boolean {
  if (channel === IPC.presenceCursor) return !payload
  if (channel === IPC.presenceChat) return typeof payload !== 'string'
  if (channel === IPC.presenceFocus) return typeof payload !== 'string' || payload === ''
  return false
}

// Relay peers (phones) have no webContents id and no ServerPlatform uiId, so their ClientIds are
// minted here from a high range that can never collide with either (both start small and count up).
let nextRelayId = 1_000_000

/** Mint a ClientId for a relay peer (a bridged HostSession). Monotonic, collision-free. */
export function allocateRelayClientId(): ClientId {
  return nextRelayId++
}

/** A peer copy safe to hand out: the nested `cursor`/`typing` objects are cloned too, so a caller
 *  holding a peers()/join-diff result cannot reach back into the hub's table through them.
 *  (The setters already assign fresh objects, so these two are the only nested state.) */
function copyPeer(p: PeerState): PeerState {
  return {
    ...p,
    cursor: p.cursor ? { ...p.cursor } : null,
    typing: p.typing ? { ...p.typing } : null
  }
}

export class PresenceHub {
  private table = new Map<ClientId, PeerState>()
  /** `${clientId}:${nodeId}` → last typing broadcast (throttle window). */
  private lastTyping = new Map<string, number>()
  /** `${clientId}:${channel}` → its token bucket (see PRESENCE_RATE_BUDGETS / allow). */
  private buckets = new Map<string, { tokens: number; at: number }>()
  private ipcRegistered = false

  /** A UI connected. Colors are assigned next-free; the name is a placeholder until hello. */
  join(clientId: ClientId, kind: PeerState['kind']): void {
    if (this.table.has(clientId)) return
    const peer: PeerState = {
      clientId,
      name: defaultNameFor(kind),
      color: nextFreeColor([...this.table.values()].map((p) => p.color)),
      cursor: null,
      focus: null,
      chat: null,
      typing: null,
      // Unknown until the client reports its active project (a phone never does in Stage 1) —
      // so it is drawn on nobody's canvas and lives in the facepile only.
      projectId: null,
      kind
    }
    this.table.set(clientId, peer)
    // The newcomer gets the whole table up front. A relay/phone peer cannot make a request, and a
    // browser's ws-bridge buffers events that land before it subscribes — so this is safe for both.
    platform().sendTo(clientId, IPC.presenceSync, this.peers())
    // A COPY, never the live PeerState: the diff crosses the shell (and, in-process on the
    // desktop, is handed to listeners as-is), so broadcasting the table's own object would let a
    // consumer hold — or mutate — hub state, and would make every later setter retroactively
    // rewrite an already-delivered diff.
    this.emit({ op: 'join', peer: copyPeer(peer) })
  }

  /** A UI disconnected. Its color frees up for the next joiner. */
  leave(clientId: ClientId): void {
    if (!this.table.delete(clientId)) return
    for (const key of [...this.lastTyping.keys()]) {
      if (key.startsWith(`${clientId}:`)) this.lastTyping.delete(key)
    }
    // Drop the rate-limit state too, or the maps would grow for the life of the process (a
    // long-lived server sees every reconnect as a new ClientId).
    for (const key of [...this.buckets.keys()]) {
      if (key.startsWith(`${clientId}:`)) this.buckets.delete(key)
    }
    this.emit({ op: 'leave', clientId })
  }

  /**
   * Take one token from this client's bucket for `channel`, or report that it is empty.
   *
   * WHERE THIS LIVES, AND WHY: at the CAST/REQUEST entry point (registerIpc) — not inside the
   * setters. The hub is a dumb reflector whose setters are also the API the shells and Stage 2's
   * internal callers use (noteTyping from the pty:write path, a relay bridge patching a phone's
   * peer); rate-limiting those would throttle the app's own trusted plumbing. The entry point is
   * the exact seam where an untrusted client's message becomes hub state, which is what needs a
   * budget — and it is the one place ALL shells funnel through, so no shell can forget it.
   *
   * A CLEARING cast (see isClearingCast) is exempt and spends no token: the bucket may only drop
   * signals whose loss is self-correcting, and a clear is an edge — losing it is lost state.
   */
  private allow(clientId: ClientId, channel: string, payload?: unknown): boolean {
    const budget = PRESENCE_RATE_BUDGETS[channel]
    if (!budget) return true
    if (isClearingCast(channel, payload)) return true
    const key = `${clientId}:${channel}`
    const now = Date.now()
    const prev = this.buckets.get(key)
    // A fresh client starts with a full bucket; an existing one refills at `perSec`, capped at
    // `burst` (so an idle minute does not bank a minute's worth of casts).
    const tokens = prev
      ? Math.min(budget.burst, prev.tokens + ((now - prev.at) / 1000) * budget.perSec)
      : budget.burst
    if (tokens < 1) {
      this.buckets.set(key, { tokens, at: now })
      return false
    }
    this.buckets.set(key, { tokens: tokens - 1, at: now })
    return true
  }

  /** The client claims an identity. Returns its own clientId (so it never draws its own cursor)
   *  plus the current table. Names are unverified by design — see docs/team-presence.md. */
  hello(clientId: ClientId, id: PeerIdentity): { clientId: ClientId; peers: PeerState[] } {
    const peer = this.table.get(clientId)
    if (!peer) return { clientId, peers: this.peers() }
    const { name, color } = sanitizeIdentity(id, { name: peer.name, color: peer.color })
    // A reconnecting client re-sends its stored identity: unchanged → no broadcast (same rule as
    // every setter below). The RETURN is unconditional — it is how the renderer learns its own
    // ClientId, without which it would draw its own cursor as a peer's.
    if (peer.name !== name || peer.color !== color) {
      peer.name = name
      peer.color = color
      this.emit({ op: 'update', clientId, patch: { name, color } })
    }
    return { clientId, peers: this.peers() }
  }

  /** Flow coordinates, or null for a peer that has no cursor (a phone, or a mouse that left). */
  setCursor(clientId: ClientId, cursor: { x: number; y: number } | null): void {
    const peer = this.table.get(clientId)
    if (!peer) return
    let next: PeerState['cursor'] = null
    if (cursor) {
      if (!Number.isFinite(cursor.x) || !Number.isFinite(cursor.y)) return
      next = { x: cursor.x, y: cursor.y }
    }
    // Unchanged → no broadcast. The renderer recomputes the flow position on every pan/zoom frame
    // and sends null on both mouse-leave and blur, so identical values are common — and each one
    // would otherwise fan out to every peer for zero visual change.
    const prev = peer.cursor
    if (prev === null ? next === null : next !== null && prev.x === next.x && prev.y === next.y) {
      return
    }
    peer.cursor = next
    this.emit({ op: 'update', clientId, patch: { cursor: next } })
  }

  /** The node this client is working in. The id is client-supplied and reflected to every peer, so
   *  it goes through the shared truncation rule (REF_MAX_LEN) exactly like chat — see presence.ts. */
  setFocus(clientId: ClientId, nodeId: string | null): void {
    const peer = this.table.get(clientId)
    if (!peer) return
    const next = typeof nodeId === 'string' && nodeId ? capCodePoints(nodeId, REF_MAX_LEN) : null
    if (peer.focus === next) return
    peer.focus = next
    this.emit({ op: 'update', clientId, patch: { focus: next } })
  }

  /** Live cursor-chat text; null closes the bubble. THE single ingest point for chat, so the
   *  CHAT_MAX_LEN cap lives here and cannot drift between the hub and the renderer. Capped by
   *  code point (capCodePoints), never by UTF-16 slice: a bubble ending in half an emoji would
   *  render as "�" for every peer. */
  setChat(clientId: ClientId, text: string | null): void {
    const peer = this.table.get(clientId)
    if (!peer) return
    const next = typeof text === 'string' ? capCodePoints(text, CHAT_MAX_LEN) : null
    // Unchanged → no broadcast (Esc-then-blur closes the bubble twice). Compared AFTER the cap:
    // two different over-long strings that cap to the same 200 code points are the same peer state.
    if (peer.chat === next) return
    peer.chat = next
    this.emit({ op: 'update', clientId, patch: { chat: next } })
  }

  /** Which project (canvas) this client is on. Everyone else uses it to decide whether this
   *  peer's cursor/focus belongs on THEIR screen (peersOnProject) — a project is a separate
   *  canvas with its own nodes and its own flow coordinates. null = no project open.
   *  Client-supplied, so capped with the shared truncation rule (REF_MAX_LEN) like every other
   *  string off the wire. */
  setProject(clientId: ClientId, projectId: string | null): void {
    const peer = this.table.get(clientId)
    if (!peer) return
    const next =
      typeof projectId === 'string' && projectId ? capCodePoints(projectId, REF_MAX_LEN) : null
    if (peer.projectId === next) return
    peer.projectId = next
    const patch: Partial<Omit<PeerState, 'clientId'>> = { projectId: next }
    // The cursor belonged to the OLD canvas. A project switch can be keyboard-driven (⌘1/⌘2, the
    // palette) with the mouse parked, so no pointermove follows it and the renderer's sampler
    // never sends a new position — the stale coordinates would then be drawn on the NEW project's
    // canvas, forever, for everyone on it. Drop it HERE (the one place that knows the canvas
    // changed) and carry both changes in ONE diff, so no peer can ever apply the new project with
    // the old cursor still attached.
    if (peer.cursor !== null) {
      peer.cursor = null
      patch.cursor = null
    }
    this.emit({ op: 'update', clientId, patch })
  }

  /** Someone wrote into a node's terminal. Throttled to 1 broadcast / TYPING_THROTTLE_MS per
   *  (client, node) — a keystroke storm must not become a broadcast storm. The badge's ~2s decay
   *  is the renderer's job (TYPING_DECAY_MS): the hub keeps no timers.
   *  Stage 2 calls this from the sender-aware pty:write handler; nothing calls it in Stage 1. */
  noteTyping(clientId: ClientId, nodeId: string): void {
    const peer = this.table.get(clientId)
    if (!peer || !nodeId) return
    const now = Date.now()
    // The throttle key is (client, node) ALONE — never the peer's *current* typing badge. Someone
    // writing alternately into two nodes (agent + shell) would never match `peer.typing.nodeId`,
    // so every keystroke would broadcast to every peer. Each node keeps its own window; a
    // different node is a different key and so still re-fires immediately.
    const key = `${clientId}:${nodeId}`
    const last = this.lastTyping.get(key) ?? 0
    if (last && now - last < TYPING_THROTTLE_MS) return
    this.lastTyping.set(key, now)
    const typing = { nodeId, at: now }
    peer.typing = typing
    this.emit({ op: 'update', clientId, patch: { typing } })
  }

  /** The current table, in join order. Copies so a caller can't mutate hub state. */
  peers(): PeerState[] {
    return [...this.table.values()].map(copyPeer)
  }

  /** How many UIs are connected. Lets a caller skip work that only matters to OTHER people: the
   *  pty:write path uses it to not report typing while the user is alone (a badge nobody but the
   *  typist would receive — and their own is never drawn). See PtyManager.write. */
  peerCount(): number {
    return this.table.size
  }

  /** Wire the presence channels into the shell. Idempotent on purpose: the shell's listener
   *  registry does not dedup identical function references, so a second registration would make
   *  every cast fire (and broadcast) twice. */
  registerIpc(): void {
    if (this.ipcRegistered) return
    this.ipcRegistered = true
    const p = platform()
    // Every entry point is rate-limited here (see allow): this is the seam where an untrusted
    // client's message becomes hub state — and every shell funnels through it.
    p.handleWithSender(IPC.presenceHello, (senderId: number, id: PeerIdentity) => {
      // A dropped hello still ANSWERS (the response is how a client learns its own ClientId, and
      // silence would hang its promise); it just doesn't apply the identity or broadcast.
      if (!this.allow(senderId, IPC.presenceHello)) return { clientId: senderId, peers: this.peers() }
      return this.hello(senderId, id)
    })
    // The payload goes to allow() too: a cast that CLEARS state is exempt from the bucket (a
    // dropped clear is permanent, and it cannot flood — see isClearingCast).
    p.onWithSender(
      IPC.presenceCursor,
      (senderId: number, cursor: { x: number; y: number } | null) => {
        if (!this.allow(senderId, IPC.presenceCursor, cursor)) return
        this.setCursor(senderId, cursor)
      }
    )
    p.onWithSender(IPC.presenceFocus, (senderId: number, nodeId: string | null) => {
      if (!this.allow(senderId, IPC.presenceFocus, nodeId)) return
      this.setFocus(senderId, nodeId)
    })
    p.onWithSender(IPC.presenceChat, (senderId: number, text: string | null) => {
      if (!this.allow(senderId, IPC.presenceChat, text)) return
      this.setChat(senderId, text)
    })
    p.onWithSender(IPC.presenceProject, (senderId: number, projectId: string | null) => {
      // NOT exempted, unlike the clears: every project cast may carry a NEW id, so it always
      // broadcasts — an unlimited one would hand a hostile tab the same N-way amplifier the buckets
      // exist to stop (a clear cannot do that: it broadcasts at most once). Its budget is instead
      // sized so far above any human input path that an honest client can never lose a switch.
      if (!this.allow(senderId, IPC.presenceProject, projectId)) return
      this.setProject(senderId, projectId)
    })
  }

  private emit(diff: PeerDiff): void {
    platform().broadcast(IPC.presencePeer, diff)
  }
}

/** The process-wide hub. Both shells (and the relay host) feed this one instance. */
export const presenceHub = new PresenceHub()
