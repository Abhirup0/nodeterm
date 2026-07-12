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
    this.emit({ op: 'leave', clientId })
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

  setFocus(clientId: ClientId, nodeId: string | null): void {
    const peer = this.table.get(clientId)
    if (!peer) return
    const next = typeof nodeId === 'string' && nodeId ? nodeId : null
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
   *  canvas with its own nodes and its own flow coordinates. null = no project open. */
  setProject(clientId: ClientId, projectId: string | null): void {
    const peer = this.table.get(clientId)
    if (!peer) return
    const next = typeof projectId === 'string' && projectId ? projectId : null
    if (peer.projectId === next) return
    peer.projectId = next
    this.emit({ op: 'update', clientId, patch: { projectId: next } })
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

  /** Wire the presence channels into the shell. Idempotent on purpose: the shell's listener
   *  registry does not dedup identical function references, so a second registration would make
   *  every cast fire (and broadcast) twice. */
  registerIpc(): void {
    if (this.ipcRegistered) return
    this.ipcRegistered = true
    const p = platform()
    p.handleWithSender(IPC.presenceHello, (senderId: number, id: PeerIdentity) =>
      this.hello(senderId, id)
    )
    p.onWithSender(
      IPC.presenceCursor,
      (senderId: number, cursor: { x: number; y: number } | null) => this.setCursor(senderId, cursor)
    )
    p.onWithSender(IPC.presenceFocus, (senderId: number, nodeId: string | null) =>
      this.setFocus(senderId, nodeId)
    )
    p.onWithSender(IPC.presenceChat, (senderId: number, text: string | null) =>
      this.setChat(senderId, text)
    )
    p.onWithSender(IPC.presenceProject, (senderId: number, projectId: string | null) =>
      this.setProject(senderId, projectId)
    )
  }

  private emit(diff: PeerDiff): void {
    platform().broadcast(IPC.presencePeer, diff)
  }
}

/** The process-wide hub. Both shells (and the relay host) feed this one instance. */
export const presenceHub = new PresenceHub()
