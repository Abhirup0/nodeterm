import { create } from 'zustand'
import {
  PRESENCE_COLORS,
  nextFreeColor,
  peersOnProject,
  type ClientId,
  type PeerDiff,
  type PeerIdentity,
  type PeerState
} from '@shared/presence'

/**
 * Transient team-presence store (docs/team-presence.md). Holds the peer table for the current
 * connection: cursors, focus, chat. NONE of it is persisted — the only thing that survives a
 * reload is the local user's own {name, color} (ME_KEY below).
 *
 * SOLE SUBSCRIBER: this module is the ONLY place that may call presence.onSync / presence.onPeer,
 * and connectPresence() is called exactly once (Canvas, []-effect). The browser bridge buffers the
 * events that arrive before the first subscriber and drains that buffer into it — a SECOND
 * subscriber on the same channel would get nothing, so components must read this store and never
 * subscribe themselves.
 *
 * PERF CONTRACT: only the presence components (PresenceLayer / Facepile / PresenceChips) may
 * subscribe to this store. Canvas.tsx is ~4000 lines — if a cursor at 20 Hz re-rendered it, every
 * mouse move would redraw the whole canvas. Canvas mounts the components and calls
 * connectPresence(); it never reads the store.
 */

export const ME_KEY = 'nodeterm.presence.me'

/** The local user's saved identity, or null on first run / corrupt storage. */
export function loadIdentity(): PeerIdentity | null {
  try {
    const raw = localStorage.getItem(ME_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PeerIdentity>
    if (typeof parsed?.name !== 'string' || typeof parsed?.color !== 'string') return null
    return { name: parsed.name, color: parsed.color }
  } catch {
    return null
  }
}

export function saveIdentity(id: PeerIdentity): void {
  try {
    localStorage.setItem(ME_KEY, JSON.stringify(id))
  } catch {
    // ignore quota / serialization errors — presence still works for this session
  }
}

/** A starting point for the name prompt: empty name, an unused-looking color. */
export function suggestIdentity(): PeerIdentity {
  const taken = Object.values(usePresence.getState().peers).map((p) => p.color)
  return { name: '', color: nextFreeColor(taken) || PRESENCE_COLORS[0] }
}

export interface PresenceStore {
  /** This client's own id (from the hello response). Null until hello resolves. */
  myId: ClientId | null
  /** The local user's identity, or null until they pick one. */
  me: PeerIdentity | null
  /** Everyone connected, INCLUDING me (selectOthers filters me out). */
  peers: Record<ClientId, PeerState>
  /** True when we are connected but the user has never chosen a name → show the prompt. */
  needsName: boolean
  setMe(id: PeerIdentity): void
  applySync(peers: PeerState[]): void
  applyDiff(diff: PeerDiff): void
  reset(): void
}

export const usePresence = create<PresenceStore>((set) => ({
  myId: null,
  me: loadIdentity(),
  peers: {},
  needsName: false,

  setMe: (id) => {
    saveIdentity(id)
    set({ me: id, needsName: false })
    void sayHello(id)
  },

  applySync: (peers) =>
    set(() => {
      const table: Record<ClientId, PeerState> = {}
      for (const p of peers) table[p.clientId] = p
      return { peers: table }
    }),

  applyDiff: (diff) =>
    set((s) => {
      if (diff.op === 'join') return { peers: { ...s.peers, [diff.peer.clientId]: diff.peer } }
      if (diff.op === 'leave') {
        if (!(diff.clientId in s.peers)) return s
        const peers = { ...s.peers }
        delete peers[diff.clientId]
        return { peers }
      }
      const prev = s.peers[diff.clientId]
      if (!prev) return s // an update for a peer we never saw join — ignore, never ghost a row
      return { peers: { ...s.peers, [diff.clientId]: { ...prev, ...diff.patch } } }
    }),

  reset: () => set({ myId: null, peers: {}, needsName: false })
}))

/** Everyone except me, on ANY project — the facepile list (it shows who is working where). */
export function selectOthers(s: PresenceStore): PeerState[] {
  return Object.values(s.peers).filter((p) => p.clientId !== s.myId)
}

/** Everyone except me, on THIS project — the ONLY peers that may be drawn on the canvas. A peer
 *  on another project has coordinates in another canvas's space (see peersOnProject). */
export function selectVisible(s: PresenceStore, projectId: string | null): PeerState[] {
  return peersOnProject(selectOthers(s), projectId)
}

/** The peers (never me, never off-project) focused on one node — drives the node-header chips.
 *  Node ids are globally unique, so without the project filter a peer focused on a node in
 *  another project would silently chip a node here. */
export function selectFocused(
  s: PresenceStore,
  nodeId: string,
  projectId: string | null
): PeerState[] {
  return selectVisible(s, projectId).filter((p) => p.focus === nodeId)
}

/**
 * Say hello and seed the peer table from the RESPONSE — not from the presence:sync push. On
 * desktop the hub joins the window at createWindow(), i.e. before the renderer has loaded, so
 * that join-time sync is always lost. The hello response is the only snapshot that is reliable
 * on BOTH surfaces, and it is also how we learn our OWN clientId (so we never draw our cursor).
 */
async function sayHello(id: PeerIdentity): Promise<void> {
  const res = await window.nodeTerminal.presence.hello(id)
  const table: Record<ClientId, PeerState> = {}
  for (const p of res.peers) table[p.clientId] = p
  usePresence.setState({ myId: res.clientId, peers: table })
}

/**
 * Subscribe to the presence stream and announce ourselves. Called EXACTLY ONCE, from Canvas in a
 * []-effect; returns a teardown. Subscribing BEFORE hello matters: any diff that lands while
 * hello is in flight must be applied on top of the snapshot, not dropped. With no stored identity
 * we subscribe but stay anonymous (`needsName`) until the prompt resolves — the hub still knows
 * us as "Someone", so nothing is lost either way.
 */
export function connectPresence(): () => void {
  const unSync = window.nodeTerminal.presence.onSync((peers) =>
    usePresence.getState().applySync(peers)
  )
  const unPeer = window.nodeTerminal.presence.onPeer((diff) =>
    usePresence.getState().applyDiff(diff)
  )
  const me = usePresence.getState().me
  if (me) void sayHello(me)
  else usePresence.setState({ needsName: true })
  return () => {
    unSync()
    unPeer()
    usePresence.getState().reset()
    // Forget what we published, so a reconnect re-announces focus + project from scratch.
    lastFocus = null
    lastProject = null
  }
}

// The last focus/project we published — a terminal re-focusing the same node, or a tab switch
// back to the project we are already on, must not spam the wire.
let lastFocus: string | null = null
let lastProject: string | null = null

/** Publish "I am working in this node" (null = nowhere). Deduped; safe to call before connect. */
export function reportFocus(nodeId: string | null): void {
  if (lastFocus === nodeId) return
  lastFocus = nodeId
  window.nodeTerminal.presence.focus(nodeId)
}

/** Publish "I am looking at this canvas" (null = no project open). Called from Canvas's
 *  active-project effect, so it fires on connect AND on every project switch. Deduped. */
export function reportProject(projectId: string | null): void {
  if (lastProject === projectId) return
  lastProject = projectId
  window.nodeTerminal.presence.project(projectId)
}
