/**
 * Hidden-webview discard ("Browser Memory Saver", the same idea as Chrome tab discarding): each
 * Electron `<webview>` is a full Chromium renderer PROCESS, and a canvas has no cap on how many
 * browser/web nodes it holds. A page that has sat hidden this long is cheaper to rebuild from its
 * URL on reveal than to keep resident.
 *
 * Two constraints are baked into the predicate:
 *  - **Never discard mid-load.** Restoring would replay a half-finished navigation (and a POST
 *    result or an interstitial would simply be lost).
 *  - **The setting is read at DECISION time, not at arm time.** A user who switches the saver off
 *    while a page is hidden must not have it discarded by a timer armed a minute earlier.
 *
 * The back/forward stack does NOT survive a discard — Electron's `<webview>` cannot serialize it.
 * What survives is the descriptor (the current URL) and the user's own history store, which is the
 * same trade Chrome makes.
 */
export const BROWSER_DISCARD_MS = 5 * 60_000

export function shouldDiscard(i: { hiddenMs: number; loading: boolean; enabled: boolean }): boolean {
  return i.enabled && !i.loading && i.hiddenMs > BROWSER_DISCARD_MS
}
