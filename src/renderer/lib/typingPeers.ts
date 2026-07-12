// Co-attach: who is typing into a node's terminal RIGHT NOW (the pulsing ring in its header).
//
// One PTY, N subscribers: two people can type into the same shell and their characters interleave.
// There is no locking in v1 — the ring IS the warning, so this deliberately answers with a LIST.
//
// Pure, and kept out of the store/component because vitest runs in the node environment (no jsdom):
// a React component cannot be unit-tested, this can. The store (state/presence.ts) owns the marks
// and the sweep timer; the component (components/PresenceChips.tsx) draws them.
//
// TWO RULES THAT ARE EASY TO GET WRONG, AND ARE THE REASON THIS MODULE EXISTS:
//
//  1. THE STAMP IS OURS, NOT THE SENDER'S. `PeerState.typing.at` (src/shared/presence.ts) is stamped
//     on the HOST's clock, and the decay would run on the VIEWER's — a browser or a phone whose
//     clock may be minutes off. Decaying against the wire stamp would pin a ring on forever (host
//     clock ahead) or never light one (behind). So the store re-stamps every typing patch with the
//     LOCAL time it observed it, and `TypingMark.at` below is that local receipt time. One clock,
//     end to end.
//
//  2. ONLY A LIVE PATCH MAY LIGHT A RING. The hub keeps no timers and never clears `typing`, so a
//     client joining later gets a `presence:sync` / hello snapshot carrying a peer's OLD typing with
//     an old stamp. The store therefore builds these marks ONLY from `presence:peer` update diffs —
//     it never seeds them from a snapshot — so a keystroke from ten minutes ago cannot ring here.

import { TYPING_DECAY_MS, type ClientId } from '@shared/presence'

/** How long a typing mark stays "live". The hub throttles noteTyping to 1 per 500 ms per
 *  (client, node), so a peer who keeps typing refreshes well inside this window and one who stopped
 *  fades out. Shared with the hub's contract — re-exported so consumers have one import. */
export { TYPING_DECAY_MS }

/** A peer's last observed write into a node. `at` is the LOCAL receipt time (see rule 1 above),
 *  never the host stamp that rode the wire. */
export interface TypingMark {
  nodeId: string
  at: number
}

/** clientId → their last write. A peer types into one node at a time, so one mark each. */
export type TypingMarks = Readonly<Record<ClientId, TypingMark>>

/** The empty answer, shared and frozen: `typingClientIds` runs once per MOUNTED NODE on every store
 *  write, and the overwhelmingly common case (nobody is typing) must allocate NOTHING and keep a
 *  stable identity, so the caller's shallow compare bails out instead of re-rendering the canvas. */
const NO_IDS: readonly ClientId[] = Object.freeze([])

/** Is this mark still live? `now - at <= decay`, so a mark from the future (a clock that stepped
 *  back mid-session) counts as live rather than instantly stale. */
function isLive(mark: TypingMark, now: number): boolean {
  return now - mark.at <= TYPING_DECAY_MS
}

/** Record "this peer just wrote into `nodeId`", stamped with OUR clock (`now`). Immutable: returns
 *  a new map, so it can be dropped straight into zustand state. */
export function markTyping(
  marks: TypingMarks,
  clientId: ClientId,
  nodeId: string,
  now: number
): TypingMarks {
  return { ...marks, [clientId]: { nodeId, at: now } }
}

/** Forget a peer entirely (they left). Returns the SAME map when there was nothing to forget, so a
 *  leave diff for a peer who never typed writes no state and re-renders nothing. */
export function dropTyping(marks: TypingMarks, clientId: ClientId): TypingMarks {
  if (!(clientId in marks)) return marks
  const next = { ...marks }
  delete next[clientId]
  return next
}

/**
 * The peers typing into `nodeId` right now, ordered by clientId — i.e. by join order, the same
 * order the header chips use. Deliberately NOT "freshest first": the order would then flip on every
 * keystroke of whoever is typing faster, and the chips would jitter; freshness is not rendered.
 *
 * The decay is applied HERE, on read, and not only by the sweep timer: a background tab's timers are
 * throttled to ~1/min, so a ring must be able to expire on the next render even if the sweep is late.
 */
export function typingClientIds(
  marks: TypingMarks,
  nodeId: string,
  now: number
): readonly ClientId[] {
  let ids: ClientId[] | null = null
  for (const key in marks) {
    const id = Number(key) as ClientId
    const mark = marks[id]
    if (mark.nodeId !== nodeId || !isLive(mark, now)) continue
    ;(ids ??= []).push(id)
  }
  if (!ids) return NO_IDS
  return ids.sort((a, b) => a - b)
}

/** Drop the marks that have decayed. Returns the SAME map when none had — the sweep then writes no
 *  state, so a peer who is still typing does not re-render anyone on every tick. */
export function pruneTyping(marks: TypingMarks, now: number): TypingMarks {
  const live: Record<ClientId, TypingMark> = {}
  let dropped = false
  for (const key in marks) {
    const id = Number(key) as ClientId
    if (isLive(marks[id], now)) live[id] = marks[id]
    else dropped = true
  }
  return dropped ? live : marks
}

/**
 * When the next mark decays, in ms from `now` — or `null` when nobody is typing, which is the whole
 * point: the store arms a timer ONLY while this is non-null, so a solo user (no peers → no typing
 * patches → no marks) never has a timer running at all. Never negative: an already-expired mark
 * sweeps on the next tick.
 */
export function nextTypingSweepDelay(marks: TypingMarks, now: number): number | null {
  let earliest: number | null = null
  for (const key in marks) {
    const at = marks[Number(key) as ClientId].at
    if (earliest === null || at < earliest) earliest = at
  }
  if (earliest === null) return null
  return Math.max(0, earliest + TYPING_DECAY_MS - now)
}
