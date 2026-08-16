// Navigation policy for <webview> guests (browser/web nodes).
//
// Guests may show http(s) pages, local content served via the jailed nt-media:// scheme, and —
// since #251 — local file:// pages typed into the address bar. file:// is origin-gated: a link
// inside a local page may go to another local page, but a remote page must never be able to
// navigate the guest to a local file. First loads (empty/about:blank guest) arrive via loadURL
// and normally bypass will-navigate; the fresh-guest allowance only mirrors that path.
export function allowGuestNavigation(currentUrl: string, targetUrl: string): boolean {
  if (/^https?:\/\//i.test(targetUrl) || /^nt-media:\/\//i.test(targetUrl)) return true
  if (/^file:\/\//i.test(targetUrl)) {
    return currentUrl === '' || currentUrl === 'about:blank' || /^file:\/\//i.test(currentUrl)
  }
  return false
}
