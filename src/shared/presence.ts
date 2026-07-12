// Team presence — the wire contract shared by src/core (PresenceHub), both shells, and the
// renderer. See docs/team-presence.md.
//
// Presence is TRANSIENT: nothing in this file is ever written to workspace.json / project.json /
// settings.json. The only thing that survives a reload is the local user's own {name, color}
// (localStorage, renderer side).

/** A connected UI. Electron: webContents.id. Server Edition: the ServerPlatform uiId.
 *  Relay peers (phones): minted from a high range by the hub (see allocateRelayClientId). */
export type ClientId = number

/** What a human claims to be. Unverified by design — presence is not a permissions feature. */
export interface PeerIdentity {
  name: string
  color: string
}

export interface PeerState {
  clientId: ClientId
  name: string
  color: string
  /** FLOW coordinates (screenToFlowPosition), never screen coords — so a cursor lands on the
   *  same node regardless of each viewer's zoom/pan. `null` = a cursorless peer (a phone). */
  cursor: { x: number; y: number } | null
  /** The node this peer is working in, or null. */
  focus: string | null
  /** Live cursor-chat text (broadcast per keystroke); null closes the bubble. */
  chat: string | null
  /** Last write into a node's terminal. Stage 2 populates this; Stage 1 always null. */
  typing: { nodeId: string; at: number } | null
  /** The project (canvas) this peer is looking at; null = none open (welcome screen). Each
   *  project has its OWN node set and flow coordinate space, so cursor/focus only mean anything
   *  to a viewer on the same project — see peersOnProject. */
  projectId: string | null
  kind: 'browser' | 'phone' | 'desktop'
}

export type PeerDiff =
  | { op: 'join'; peer: PeerState }
  /** `clientId` is the identity key and is carried by the diff itself — a patch can never
   *  rewrite it (that would silently reassign the peer). */
  | { op: 'update'; clientId: ClientId; patch: Partial<Omit<PeerState, 'clientId'>> }
  | { op: 'leave'; clientId: ClientId }

/** Peer colors, assigned next-free on join. Picked for contrast on the black canvas.
 *  `readonly`: color assignment is app-wide state, so no consumer may push/sort/assign into it. */
export const PRESENCE_COLORS: readonly string[] = [
  '#5ac8fa', // blue
  '#ff9f0a', // orange
  '#30d158', // green
  '#ff375f', // pink
  '#bf5af2', // purple
  '#ffd60a', // yellow
  '#64d2ff', // cyan
  '#ff6b3d' // clay
]

/** How long a typing badge stays lit after the last keystroke (Stage 2 renders this). */
export const TYPING_DECAY_MS = 2000
/** Caps: a peer cannot flood the wire with a giant name or chat line. */
export const NAME_MAX_LEN = 32
export const CHAT_MAX_LEN = 200

/** First palette color not already in use; wraps by count once every color is taken.
 *  `taken` is `readonly` so callers stay unconstrained (a mutable `string[]` is accepted). */
export function nextFreeColor(taken: readonly string[]): string {
  const used = new Set(taken)
  const free = PRESENCE_COLORS.find((c) => !used.has(c))
  return free ?? PRESENCE_COLORS[taken.length % PRESENCE_COLORS.length]
}

/** The name a peer carries until it sends presence:hello (a phone may never send one). */
export function defaultNameFor(kind: PeerState['kind']): string {
  return kind === 'phone' ? 'Phone' : 'Someone'
}

/**
 * The peers whose cursor / focus is meaningful to a viewer on `projectId`. THE project filter:
 * a project is a canvas with its own nodes and its own flow coordinate space, so a peer on
 * another project must not be drawn here at all (their coordinates would be meaningless and
 * their focused node id — globally unique — would chip the wrong header). With no project open
 * (`null`) nothing is drawn. The facepile deliberately does NOT use this: it shows everyone.
 */
export function peersOnProject(peers: PeerState[], projectId: string | null): PeerState[] {
  if (projectId === null) return []
  return peers.filter((p) => p.projectId === projectId)
}

/** Cap a string at `max` *code points*, not UTF-16 code units: `slice` would cut a surrogate
 *  pair (emoji, CJK extensions) in half and leave a lone surrogate, which renders as "�" in
 *  every peer's facepile / chat bubble. The single truncation rule for the whole feature — the
 *  hub caps chat with it (CHAT_MAX_LEN) and capName caps names with it.
 *
 *  COST IS O(max), NOT O(text) — deliberately. This is a door for UNTRUSTED input (any client can
 *  cast a `presence:chat` / `presence:focus` of whatever size the socket accepts), and the obvious
 *  `[...text].slice(0, max)` spreads the WHOLE string into an array of code points BEFORE capping:
 *  a multi-MB frame would block the event loop for seconds and balloon the heap — a trivial remote
 *  DoS on the shared Server Edition process. A code point is at most 2 UTF-16 code units, so the
 *  first `max` code points always live inside the first `max * 2` code units: bound the input with
 *  a (O(1), no-copy) `slice` first, and only spread that. The bounded slice may end on a lone high
 *  surrogate, but that surrogate can only ever land at index >= max in the spread, so the cap
 *  drops it — no half-emoji can survive. */
export function capCodePoints(text: string, max: number): string {
  if (max <= 0) return ''
  // Fewer code units than the cap ⇒ fewer code points than the cap. Nothing to do.
  if (text.length <= max) return text
  const bounded = [...text.slice(0, max * 2)]
  if (bounded.length <= max) return bounded.join('')
  return bounded.slice(0, max).join('')
}

/** Cap a name at NAME_MAX_LEN code points. Trim runs again AFTER the cut, so a truncation
 *  landing on a space doesn't leave a trailing one. */
function capName(name: string): string {
  return capCodePoints(name.trim(), NAME_MAX_LEN).trim()
}

/** Coerce an untrusted {name, color} off the wire into a safe identity. Names are unverified
 *  (anyone can claim any name — documented trade-off) but they are length-capped, and the color
 *  must be one of ours so it can never be injected into a style attribute as arbitrary text. */
export function sanitizeIdentity(raw: unknown, fallback: PeerIdentity): PeerIdentity {
  const r = (raw ?? {}) as Partial<PeerIdentity>
  const name = typeof r.name === 'string' ? capName(r.name) : ''
  const color =
    typeof r.color === 'string' && PRESENCE_COLORS.includes(r.color) ? r.color : fallback.color
  return { name: name || fallback.name, color }
}
