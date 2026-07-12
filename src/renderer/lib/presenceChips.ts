// Pure logic behind the per-node presence chips (components/PresenceChips.tsx): which of the peers
// focused on a node get an avatar in its header, in what order, and when they collapse into a "+N"
// bubble. Kept out of the component because vitest runs in the node environment (no jsdom), so a
// React component cannot be unit-tested — this can.
//
// The chips answer "who else is in THIS terminal". The project filter that makes that question
// meaningful (node ids are globally unique) lives in selectFocusedFaces — by the time faces reach
// here they are already the peers on our canvas, focused on our node.

import type { PeerFace } from '../state/presence'

/** How many avatars a node header shows before collapsing the rest into "+N". A terminal header is
 *  a crowded strip (account chip, SSH chip, context meter, RUNNING badge…), so the budget is small;
 *  the facepile is where you go to see everyone. */
export const MAX_CHIPS = 3

export interface PresenceChip {
  clientId: number
  /** The single letter drawn in the circle (upper-cased first letter of the name). */
  letter: string
  color: string
  title: string
  /** This peer's keystrokes are landing in THIS shell right now → the chip pulses (styles.css).
   *  One PTY, N subscribers and no locking: two people typing into one shell interleave their
   *  characters, so the ring is the warning that it is happening. */
  typing: boolean
}

export interface PresenceChipStrip {
  chips: PresenceChip[]
  /** How many focused peers are hidden behind the "+N" bubble; 0 = no bubble. */
  overflow: number
  /** The hidden peers' names, for the bubble's tooltip. '' when there is no bubble. */
  overflowTitle: string
}

function letterOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

function byClientId(a: PeerFace, b: PeerFace): number {
  return a.clientId - b.clientId
}

/**
 * Project the peers at one node into its header strip: `faces` are the peers FOCUSED here (who is in
 * this terminal), `typists` the peers whose keystrokes are landing in it right now (state/presence
 * selectTypingFaces). The two overlap in the normal case — you focus the node you type into — and
 * are merged by clientId, so a peer is never chipped twice.
 *
 * A TYPIST WHO IS NOT IN `faces` STILL GETS A CHIP. That is not an edge case: a phone has no canvas
 * (`projectId: null`, so the project-filtered focus list excludes it) but can very much be typing
 * into this shell — which is precisely what you need to know before you touch the keyboard.
 *
 * Typists come FIRST, so the ring can never be the thing that falls behind the "+N" bubble: a chip
 * you cannot see warns nobody. Within each group the order is clientId — i.e. join order — so a chip
 * does not jump around as the peer table is rebuilt (it is a plain object; we do not depend on its
 * key order), and typing itself never reshuffles the strip.
 *
 * Overflow spends the LAST slot on the bubble: with a cap of 3 and five peers you get two faces and
 * "+3" — never three faces and a fourth item, which would blow the header's width budget.
 */
export function chipStrip(
  faces: readonly PeerFace[],
  typists: readonly PeerFace[] = [],
  max: number = MAX_CHIPS
): PresenceChipStrip {
  const typingIds = new Set(typists.map((f) => f.clientId))
  const rest = faces.filter((f) => !typingIds.has(f.clientId)).sort(byClientId)
  const ordered = [...[...typists].sort(byClientId), ...rest]
  const fits = ordered.length <= max
  const shown = fits ? ordered : ordered.slice(0, Math.max(max - 1, 0))
  const hidden = fits ? [] : ordered.slice(shown.length)
  return {
    chips: shown.map((f) => ({
      clientId: f.clientId,
      letter: letterOf(f.name),
      color: f.color,
      title: typingIds.has(f.clientId)
        ? `${f.name} is typing in this terminal`
        : `${f.name} is here`,
      typing: typingIds.has(f.clientId)
    })),
    overflow: hidden.length,
    overflowTitle: hidden.map((f) => f.name).join(', ')
  }
}
