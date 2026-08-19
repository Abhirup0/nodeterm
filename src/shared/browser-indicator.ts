/**
 * The DRIVING indicator's shared vocabulary — the one fact both main (which owns the lease) and the
 * renderer (which paints the chip and highlights the rope) must agree on. Lives in `src/shared`
 * because both shells import it (global constraint 4: anything both sides need lives here, never a
 * renderer→main import). Pure — no electron, no DOM — so the visibility rule is unit-tested on its
 * own.
 *
 * S8 PR 6 of external PR #112 (@Corvin / proteus-dev): the on-node "…is driving" chip + Stop. The
 * lease that FEEDS this (the `browser` verb) lands in PR 7; until then nothing sets a live
 * `leaseActiveUntil`, so the chip stays hidden in practice while every mechanism below is real.
 */


/**
 * How long the chip lingers AFTER a lease's `leaseActiveUntil` has passed. A single verb (a
 * `--read` that completes in ~50 ms) would otherwise flicker the chip for 50 ms and inform nobody; a
 * burst of verbs must read as one continuous "is driving", which is also the truth (the debugger is
 * still attached for the whole idle window). The debugger's own idle window (`LEASE_IDLE_MS`, 60 s)
 * is a separate, invisible perf concern; this is purely how long the badge outlives it so the
 * transition to "gone" is a fade, not a blink. An EXPLICIT Stop bypasses this entirely (see the
 * store): the user stopped it, so the chip must vanish at once, not linger.
 */
export const INDICATOR_LINGER_MS = 5_000

/** One driven browser node, as main pushes it and the renderer store keeps it. `ownerNodeId` is the
 *  VERIFIED owner from the in-memory ledger (never a rope, never a caller label); the renderer
 *  resolves its title for the chip. `leaseActiveUntil` is the ledger's live window. */
export interface BrowserLeaseEntry {
  ownerNodeId: string
  leaseActiveUntil: number
}

/** The main→renderer push payload. `active` is the CURRENT live-lease set (upserted); `stopped` are
 *  nodes whose control was just revoked and must drop from the chip immediately, skipping the
 *  linger — that is the difference between "a verb finished" (fade) and "the user pressed Stop"
 *  (gone). */
export interface BrowserLeasePush {
  active: { browserNodeId: string; ownerNodeId: string; leaseActiveUntil: number }[]
  stopped: string[]
}

/**
 * Is the chip visible for this entry at `now`? True while the lease is live OR within
 * {@link INDICATOR_LINGER_MS} of it ending. The single rule the chip, the rope highlight and the
 * kill-row list all read, so they can never disagree about whether a node "is driving".
 */
export function chipVisibleAt(entry: BrowserLeaseEntry, now: number): boolean {
  return now < entry.leaseActiveUntil + INDICATOR_LINGER_MS
}
