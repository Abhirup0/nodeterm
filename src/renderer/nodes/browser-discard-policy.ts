/**
 * Hidden-webview discard ("Browser Memory Saver", the same idea as Chrome tab discarding): each
 * Electron `<webview>` is a full Chromium renderer PROCESS, and a canvas has no cap on how many
 * browser/web nodes it holds. A page that has sat hidden this long is cheaper to rebuild from its
 * URL on reveal than to keep resident.
 *
 * Three constraints are baked into the predicate:
 *  - **Never discard mid-load.** Restoring would replay a half-finished navigation (and a POST
 *    result or an interstitial would simply be lost).
 *  - **Never discard a page making noise.** Audible = in use, even off-screen (a call, music, a
 *    video the user is listening to). Chrome exempts audible tabs for the same reason.
 *  - **Never discard a page an agent is driving.** A live control lease is "in use even though
 *    hidden", the same category as loading and audible. Without this, an agent drives a node, the
 *    user pans away, and five minutes later the target is destroyed mid-task with no signal: the
 *    restore re-navigates to the stored URL, so cookies survive but form state, scroll position and
 *    every post-login SPA state do not, and every element reference from the last read is silently
 *    stale. The cost is a whole Chromium renderer held resident until the lease ends — bounded by
 *    whatever idle timeout the driver enforces, and preferable to a feature that fails five minutes
 *    into every long task. The input is optional, so a surface with no notion of a lease (every
 *    surface today) behaves exactly as it did before it existed.
 *  - **The setting is re-read when the timer FIRES, not when it was armed** — so a user who
 *    switches the saver off during a hidden stretch is not discarded by an older timer. The
 *    symmetry is deliberately incomplete: switching the saver ON mid-hide does NOT discard that
 *    page at the end of the current stretch, because the disabled branch arms no retry (pinned by
 *    `useDiscardWhenHidden.test.tsx`). Such a page is picked up on its next hide→show cycle. The
 *    conservative direction is the right one — a user turning the feature off must be obeyed at
 *    once, one turning it on can wait.
 *
 * The back/forward stack does NOT survive a discard — Electron's `<webview>` cannot serialize it.
 * What survives is the descriptor (the current URL) and the user's own history store, which is the
 * same trade Chrome makes.
 */
export const BROWSER_DISCARD_MS = 5 * 60_000

export function shouldDiscard(i: {
  hiddenMs: number
  loading: boolean
  enabled: boolean
  /** Is the page making sound right now? Optional so a surface that cannot tell says nothing. */
  audible?: boolean
  /**
   * Is an agent driving this page right now (a live control lease)?
   *
   * Optional for the same reason as `audible`: a surface that cannot tell must behave exactly as it
   * did before the input existed. It is a SUPPRESSOR, never an exemption — the caller re-reads it
   * when the timer fires, so a page whose lease ended is discardable on the next pass.
   */
  driven?: boolean
}): boolean {
  return i.enabled && !i.loading && !i.audible && !i.driven && i.hiddenMs > BROWSER_DISCARD_MS
}
