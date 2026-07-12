import { create } from 'zustand'
import {
  nextFreeColor,
  peersOnProject,
  type ClientId,
  type PeerDiff,
  type PeerIdentity,
  type PeerState
} from '@shared/presence'
import {
  dropTyping,
  markTyping,
  nextTypingSweepDelay,
  pruneTyping,
  typingClientIds,
  type TypingMarks
} from '../lib/typingPeers'

/**
 * Transient team-presence store (docs/team-presence.md). Holds the peer table for the current
 * connection: cursors, focus, chat. NONE of it is persisted — the only thing that survives a
 * reload is the local user's own {name, color} (ME_KEY below).
 *
 * SOLE SUBSCRIBER: this module is the ONLY place that may call presence.onSync / presence.onPeer,
 * and connectPresence() subscribes AT MOST ONCE (the module-level `live` handle below makes that
 * structural, not a convention — a second call is inert). The browser bridge buffers the events
 * that arrive before the first subscriber and drains that buffer into it — a SECOND subscriber on
 * the same channel would get nothing, so components must read this store and never subscribe
 * themselves.
 *
 * NEVER MY OWN PEER: the hub's table includes us, so every selector filters on `myId` — and while
 * `myId` is null (hello in flight, or a failed handshake) they return NOTHING at all. That null
 * window is real: the browser bridge drains its buffer — the join-time `presence:sync`, which
 * contains our own peer, and our own join diff — into the first subscriber synchronously, i.e.
 * before hello can possibly have resolved. Without the gate we would list ourselves in the
 * facepile and chase our own ghost cursor.
 *
 * PERF CONTRACT: only the presence components (PresenceLayer / Facepile / PresenceChips) may
 * subscribe to this store REACTIVELY. Canvas.tsx is ~4000 lines — if a cursor at 20 Hz re-rendered
 * it, every mouse move would redraw the whole canvas. Canvas mounts the components and calls
 * connectPresence(); it never uses the `usePresence(selector)` hook. It does read the peer table
 * IMPERATIVELY — `getState()` + a plain `subscribe()` into a ref — for the canvas-sync solo gate
 * ("is anyone else attached?"). That is not a subscription React can re-render on: no hook, no
 * selector, no component state. Keep it that way.
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
  return { name: '', color: nextFreeColor(taken) }
}

export interface PresenceStore {
  /** This client's own id (from the hello response). Null until hello resolves. */
  myId: ClientId | null
  /** The local user's identity, or null until they pick one. */
  me: PeerIdentity | null
  /** Everyone connected, INCLUDING me (selectOthers filters me out). */
  peers: Record<ClientId, PeerState>
  /** Who is typing into which node, stamped on OUR clock. Built ONLY from live `presence:peer`
   *  update diffs — never from a snapshot (see THE TYPING MARKS below) — and swept by a timer that
   *  only exists while it is non-empty. Not `PeerState.typing`, and not a mirror of it. */
  typing: TypingMarks
  /** True when we are connected but the user has never chosen a name → show the prompt. */
  needsName: boolean
  setMe(id: PeerIdentity): void
  applySync(peers: PeerState[]): void
  applyDiff(diff: PeerDiff): void
  reset(): void
}

/**
 * THE TYPING MARKS — why the ring does not read `PeerState.typing` off the wire.
 *
 * CLOCK: `PeerState.typing.at` is stamped on the HOST's clock; the ~2 s decay runs on the VIEWER's
 * (a browser, a phone), which can be minutes off. Decaying against the wire stamp would pin a ring
 * on forever or suppress it entirely, so every typing patch is RE-STAMPED with the local time we
 * observed it (`markTyping(..., Date.now())`) and the decay runs against that. One clock, end to end.
 *
 * SNAPSHOTS: the hub keeps no timers and never clears `typing`, so a `presence:sync` (or the hello
 * response) can carry a peer's typing from ten minutes ago. We therefore mark ONLY on a live `update`
 * diff and NEVER seed from a snapshot — a stale stamp in a join snapshot can light nothing.
 *
 * A stale mark for a peer who has left is harmless: the selectors skip a clientId that is not in the
 * peer table, and the sweep (armed for as long as any mark exists) removes it within TYPING_DECAY_MS.
 */
export const usePresence = create<PresenceStore>((set, get) => ({
  myId: null,
  me: loadIdentity(),
  peers: {},
  typing: {},
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
      return { peers: table } // `typing` untouched: a snapshot may not light a ring (see above)
    }),

  applyDiff: (diff) => {
    const marksBefore = get().typing
    set((s) => {
      if (diff.op === 'join') return { peers: { ...s.peers, [diff.peer.clientId]: diff.peer } }
      if (diff.op === 'leave') {
        if (!(diff.clientId in s.peers)) return s
        const peers = { ...s.peers }
        delete peers[diff.clientId]
        return { peers, typing: dropTyping(s.typing, diff.clientId) }
      }
      const prev = s.peers[diff.clientId]
      if (!prev) return s // an update for a peer we never saw join — ignore, never ghost a row
      const peers = { ...s.peers, [diff.clientId]: { ...prev, ...diff.patch } }
      const t = diff.patch.typing
      if (!t) return { peers }
      return { peers, typing: markTyping(s.typing, diff.clientId, t.nodeId, Date.now()) }
    })
    // Arm (or re-arm) the decay sweep AFTER the write, never inside the reducer — and ONLY when the
    // marks actually moved. A cursor patch (~20/s per peer) must not churn the timer, and a canvas
    // nobody else is typing on must not have one at all.
    const marksAfter = get().typing
    if (marksAfter !== marksBefore) armSweep(marksAfter)
  },

  reset: () => {
    cancelSweep()
    set({ myId: null, peers: {}, typing: {}, needsName: false })
  }
}))

/**
 * The decay sweep: the hub never sends a "stopped typing" event (it keeps no timers), so the ring
 * has to fade on OUR side. ONE timer for the whole app — not one per node — armed at the earliest
 * mark's expiry and re-armed after each sweep while any mark is left.
 *
 * A SOLO USER PAYS NOTHING: no peers → no typing diffs → no marks → nextTypingSweepDelay is null →
 * no timer is ever created. The timer exists only while someone is actually typing into a node.
 */
let sweepTimer: ReturnType<typeof setTimeout> | null = null

function cancelSweep(): void {
  if (sweepTimer !== null) clearTimeout(sweepTimer)
  sweepTimer = null
}

function armSweep(marks: TypingMarks): void {
  const delay = nextTypingSweepDelay(marks, Date.now())
  if (delay === null) return cancelSweep() // nobody is typing → no timer at all
  cancelSweep()
  sweepTimer = setTimeout(sweep, delay)
}

function sweep(): void {
  sweepTimer = null
  const s = usePresence.getState()
  const next = pruneTyping(s.typing, Date.now())
  // pruneTyping returns the SAME map when nothing decayed, so a still-typing peer costs no write
  // (and so re-renders nobody) on the ticks in between.
  if (next !== s.typing) usePresence.setState({ typing: next })
  armSweep(next)
}

/** Everyone except me, on ANY project — the base of every other selector (the facepile shows who
 *  is working where, so it does NOT filter by project).
 *  While `myId` is null we cannot tell our own peer from a teammate's, so we return NOBODY: an
 *  empty facepile for one round-trip is right; listing yourself as your own teammate never is. */
export function selectOthers(s: PresenceStore): PeerState[] {
  if (s.myId === null) return []
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

/** What the facepile draws — and NOTHING else. `applyDiff` replaces the whole PeerState object on
 *  every cursor patch (~20/s per peer), so a facepile subscribed to PeerState would re-render at
 *  cursor rate even under useShallow. selectFaces projects these five fields and reuses the
 *  previous object when they are unchanged, so cursor traffic is invisible to it. */
export interface PeerFace {
  clientId: ClientId
  name: string
  color: string
  projectId: string | null
  kind: PeerState['kind']
}

/** clientId → the last face we handed out, so an unchanged face keeps its object identity. */
const faceCache = new Map<ClientId, PeerFace>()

/** The cached face for a peer: the SAME object as last time while none of the five projected fields
 *  changed — that identity is what makes every face-based selector cursor-immune. */
function faceFor(p: PeerState): PeerFace {
  const prev = faceCache.get(p.clientId)
  if (
    prev &&
    prev.name === p.name &&
    prev.color === p.color &&
    prev.projectId === p.projectId &&
    prev.kind === p.kind
  ) {
    return prev
  }
  const face: PeerFace = {
    clientId: p.clientId,
    name: p.name,
    color: p.color,
    projectId: p.projectId,
    kind: p.kind
  }
  faceCache.set(p.clientId, face)
  return face
}

/** The facepile projection: everyone but me, cursor-immune (see PeerFace). Pair it with
 *  `useShallow` — the array is fresh each call, its ELEMENTS are not. */
export function selectFaces(s: PresenceStore): PeerFace[] {
  const others = selectOthers(s)
  const faces = others.map(faceFor)
  // Prune rather than accumulate: a peer that left must not linger in the cache. (This is the only
  // pruner — selectFocusedFaces sees a subset of the peers and must never evict the rest.)
  const alive = new Set(others.map((p) => p.clientId))
  for (const id of faceCache.keys()) if (!alive.has(id)) faceCache.delete(id)
  return faces
}

/** The one empty result every "nobody to draw" path returns — a shared, frozen constant, so the
 *  common case allocates NOTHING and its identity is stable across calls (useShallow bails out). */
const NO_FACES: PeerFace[] = []

/** Is there anyone but me in the table? The literal question the chip fast path asks — not a proxy
 *  for it (`Object.keys(peers).length < 2` assumed my own row is always one of them: a client that
 *  dropped mid-handshake, or a hello answered before our join diff landed, leaves a table of ONE
 *  REAL peer — whom the Facepile happily draws while the chips stayed blank; the two surfaces must
 *  never disagree about who is here).
 *  ALLOCATION-FREE, and that is the point: this runs once per MOUNTED NODE on EVERY store write
 *  (~4k times/s on a busy canvas), so it may not build an array — `for…in` walks the keys in place,
 *  `Object.keys()` would materialize one every single time. */
function hasOtherPeers(s: PresenceStore): boolean {
  if (s.myId === null) return false // hello unresolved → we cannot tell our own row from a peer's
  for (const key in s.peers) {
    if (s.peers[key as unknown as ClientId].clientId !== s.myId) return true
  }
  return false
}

/** What ONE node's header chips draw: the peers (never me, never off-project) focused on that node,
 *  projected to the same cursor-immune face objects as the facepile.
 *
 *  PERF, and the reason this is not just `selectFocused`: there is one chip strip PER NODE, and
 *  `applyDiff` rebuilds a peer's whole PeerState object on every cursor patch (~20/s per peer). A
 *  selector returning PeerStates would therefore hand every node a fresh object 20×/s and re-render
 *  every terminal on the canvas — even under `useShallow`, which compares the ELEMENTS. Faces are
 *  reused objects, so a moving cursor changes nothing here and every strip bails out.
 *
 *  The early-out is the other half of that: this runs once per MOUNTED NODE on every store write
 *  (40 nodes × 5 peers × 20 Hz ≈ 4k runs/s), and each run would otherwise allocate a filtered array
 *  plus a mapped one — ~20k throwaway arrays/s — even on a canvas nobody else is on. When there is
 *  provably no one to chip (hello unresolved, or nobody else in the table), return NO_FACES. */
export function selectFocusedFaces(
  s: PresenceStore,
  nodeId: string,
  projectId: string | null
): PeerFace[] {
  // Nobody else here → nothing to compute, which is the overwhelmingly common case. The guard is
  // itself allocation-free (see hasOtherPeers), or it would defeat its own purpose.
  if (!hasOtherPeers(s)) return NO_FACES
  const focused = selectFocused(s, nodeId, projectId)
  if (focused.length === 0) return NO_FACES
  return focused.map(faceFor)
}

/**
 * The peers TYPING INTO this node right now — the pulsing ring in its header. Same cursor-immune
 * PeerFace projection as the chips (see selectFocusedFaces), so pair it with `useShallow`.
 *
 * DELIBERATELY NOT PROJECT-FILTERED, unlike every other node-scoped selector here. A phone has
 * `projectId: null` (it has no canvas), so `peersOnProject` excludes it — and "someone is typing
 * into this shell from their phone" is exactly the case this feature exists to surface. The filter
 * exists because cursors and focus are only meaningful in a project's own coordinate/node space;
 * `typing.nodeId` is neither: it is the session's persistKey, GLOBALLY unique, so keying the ring
 * off it against the FULL peer table cannot chip the wrong node. If the peer is not typing into a
 * node on our canvas, no mounted header asks about their nodeId and nothing is drawn.
 *
 * CURSOR IMMUNITY: a cursor patch touches `peers` only — never `typing` — and faces are the same
 * objects until a name/color/project/kind changes, so this returns a shallow-equal array (usually
 * the shared NO_FACES) on every cursor tick and re-renders nothing.
 */
export function selectTypingFaces(s: PresenceStore, nodeId: string): PeerFace[] {
  if (s.myId === null) return NO_FACES // hello unresolved → we cannot rule out our own keystrokes
  const ids = typingClientIds(s.typing, nodeId, Date.now())
  if (ids.length === 0) return NO_FACES // the common case, allocation-free (see typingClientIds)
  const faces: PeerFace[] = []
  for (const id of ids) {
    // Never me: my own writes are echoed back to me as a diff, and a ring on my own keystrokes
    // would be noise. A mark for a peer who has left has no face — skip it.
    if (id === s.myId) continue
    const peer = s.peers[id]
    if (peer) faces.push(faceFor(peer))
  }
  return faces.length > 0 ? faces : NO_FACES
}

/** Sent when the user has not named themselves yet. It claims NOTHING — sanitizeIdentity falls
 *  back to the peer's current name on an empty string, and to its current color on an off-palette
 *  one — so the hub keeps the "Someone" + next-free color it assigned at join. Its only job is to
 *  hand us our own ClientId immediately (see NEVER MY OWN PEER above); the name prompt then just
 *  renames us with a second hello. */
const PROVISIONAL_IDENTITY: PeerIdentity = { name: '', color: '' }

/** A failed handshake logs once per session, not once per retry. */
let helloWarned = false

/**
 * Say hello and seed the peer table from the RESPONSE — not from the presence:sync push. On
 * desktop the hub joins the window at createWindow(), i.e. before the renderer has loaded, so
 * that join-time sync is always lost. The hello response is the only snapshot that is reliable
 * on BOTH surfaces, and it is also how we learn our OWN clientId (so we never draw our cursor).
 *
 * The seed REPLACES the table wholesale, and that is only safe because of two properties — do not
 * move this seed onto an unordered path (a fan-out event, a second channel, a retry queue):
 *   1. the hub snapshots peers() INSIDE the hello handler, so the response is a consistent table
 *      as of that moment, and
 *   2. hello's response and the presence:peer diffs share one FIFO transport (ipcRenderer /
 *      the single ws), so every diff we already applied is included in that snapshot and every
 *      diff we apply after it happened after it.
 * Break either one and a peer who joins mid-handshake gets silently overwritten out of the table.
 *
 * A rejection (ws dropped mid-handshake, a host without the channel) must never become an
 * unhandled rejection: we log once and leave myId null, which the selectors read as "presence is
 * off" — degraded, but never "I am my own peer".
 */
async function sayHello(id: PeerIdentity): Promise<void> {
  try {
    const res = await window.nodeTerminal.presence.hello(id)
    const table: Record<ClientId, PeerState> = {}
    for (const p of res.peers) table[p.clientId] = p
    usePresence.setState({ myId: res.clientId, peers: table })
  } catch (err) {
    if (!helloWarned) {
      helloWarned = true
      console.warn('[presence] hello failed — presence is off for this session', err)
    }
  }
}

/** The live connection, or null. Makes the single-subscriber invariant STRUCTURAL: a second
 *  connect (Fast Refresh, a stray double mount) is inert, and a teardown only tears down the
 *  connection IT created — otherwise the stale teardown would reset() the store (dropping myId
 *  and the whole table) while the live subscription, which will never re-seed, kept running. */
let live: { stop: () => void } | null = null

/**
 * Subscribe to the presence stream and announce ourselves; returns a teardown. Called from Canvas
 * in a []-effect — but calling it twice is safe (the second call is a no-op returning a no-op).
 * Subscribing BEFORE hello matters: any diff that lands while hello is in flight must be applied
 * on top of the snapshot, not dropped. We say hello even with no stored identity (see
 * PROVISIONAL_IDENTITY): the prompt (`needsName`) then only renames us.
 */
export function connectPresence(): () => void {
  if (live) return () => {}

  const unSync = window.nodeTerminal.presence.onSync((peers) =>
    usePresence.getState().applySync(peers)
  )
  const unPeer = window.nodeTerminal.presence.onPeer((diff) =>
    usePresence.getState().applyDiff(diff)
  )
  const me = usePresence.getState().me
  if (!me) usePresence.setState({ needsName: true })
  void sayHello(me ?? PROVISIONAL_IDENTITY)

  const handle = {
    stop: () => {
      if (live !== handle) return // already torn down, or superseded — touch nothing
      live = null
      unSync()
      unPeer()
      usePresence.getState().reset()
      faceCache.clear()
      // Forget what we published, so a reconnect re-announces focus + project from scratch.
      lastFocus = null
      lastProject = null
    }
  }
  live = handle
  return handle.stop
}

// The last focus/project we published — a terminal re-focusing the same node, or a tab switch
// back to the project we are already on, must not spam the wire.
//
// THE DEDUP IS A CLAIM THAT THE CAST LANDED, so it is only sound for casts the hub cannot drop.
// The hub rate-limits per (client, channel) and drops silently; there is no ack and no re-announce.
// It is sound here because of two hub rules (src/core/presence/hub.ts — keep them in sync):
//   - a CLEARING cast (focus null) is exempt from the bucket, so `lastFocus = null` can never be a
//     lie. A dropped non-null focus is self-healing anyway: the hub keeps the previous node, and
//     the very next focus change — or the exempt release — corrects it.
//   - `presence:project` is bucketed, but with a budget no human input path can reach (only
//     DISTINCT switches spend a token — this dedup is what makes key-repeat free), so an honest
//     client cannot lose the switch it has already recorded here.
// Do not tighten the project budget without revisiting this line: a dropped project cast that we
// have already recorded is permanent — teammates keep drawing us on a canvas we left.
let lastFocus: string | null = null
let lastProject: string | null = null

/**
 * Publish "I am working in this node" (null = nowhere). Deduped; safe to call before connect.
 *
 * ALONE, IT PUBLISHES NOTHING. A focus only exists to be drawn on somebody else's canvas, and every
 * terminal hover-dwell / leave calls this — so with no peers the cast is pure cost (an IPC
 * round-trip and a hub write per hover, on a path a solo user is on constantly). Same guard
 * PtyManager.write already uses for typing attribution: presence is FREE when you are by yourself.
 *
 * The CLEAR is deliberately not gated: `lastFocus` is only ever non-null because a publish went out
 * while peers existed, and if the last peer leaves while we sit in that node, the hub still holds
 * our focus — the next peer to join would receive it in its snapshot and chip a node we left long
 * ago. So a retraction always goes out (the dedup above makes it a no-op when we never published).
 */
export function reportFocus(nodeId: string | null): void {
  if (lastFocus === nodeId) return
  if (nodeId !== null && !hasPeers()) return
  lastFocus = nodeId
  window.nodeTerminal.presence.focus(nodeId)
}

/** Is anyone else connected? (The table includes me, so "somebody else" is > 1.) */
function hasPeers(): boolean {
  return Object.keys(usePresence.getState().peers).length > 1
}

/** "This node is no longer where I work" — the counterpart of reportFocus(nodeId), for a node that
 *  is losing focus (mouse left, unmounted). It clears the focus ONLY if this node is the one we
 *  actually published: a node's leave/unmount can land AFTER the next node's enter (the mouse moves
 *  on; a project switch unmounts the old canvas), and an unconditional reportFocus(null) would then
 *  blank the chips on the node the user just moved into. */
export function releaseFocus(nodeId: string): void {
  if (lastFocus !== nodeId) return
  reportFocus(null)
}

/** Publish "I am looking at this canvas" (null = no project open). Called from Canvas's
 *  active-project effect, so it fires on connect AND on every project switch. Deduped. */
export function reportProject(projectId: string | null): void {
  if (lastProject === projectId) return
  lastProject = projectId
  window.nodeTerminal.presence.project(projectId)
}
