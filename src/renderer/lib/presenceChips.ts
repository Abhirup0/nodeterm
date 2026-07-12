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

/**
 * Project the peers focused on one node into its header strip. Ordered by clientId — i.e. by join
 * order — so a chip never jumps around as the peer table is rebuilt (it is a plain object, and we
 * do not want to depend on its key order).
 *
 * Overflow spends the LAST slot on the bubble: with a cap of 3 and five peers you get two faces and
 * "+3" — never three faces and a fourth item, which would blow the header's width budget.
 */
export function chipStrip(faces: readonly PeerFace[], max: number = MAX_CHIPS): PresenceChipStrip {
  const ordered = [...faces].sort((a, b) => a.clientId - b.clientId)
  const fits = ordered.length <= max
  const shown = fits ? ordered : ordered.slice(0, Math.max(max - 1, 0))
  const hidden = fits ? [] : ordered.slice(shown.length)
  return {
    chips: shown.map((f) => ({
      clientId: f.clientId,
      letter: letterOf(f.name),
      color: f.color,
      title: `${f.name} is here`
    })),
    overflow: hidden.length,
    overflowTitle: hidden.map((f) => f.name).join(', ')
  }
}
