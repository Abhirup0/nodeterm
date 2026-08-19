// `normalizeAddress` now lives in `src/shared` so main's CDP allowlist can reuse the exact scheme
// check the address bar uses (they must never disagree about javascript:/file:/data:). Re-exported
// here so every existing `../nodes/browserUrl` import path is unchanged.
export { normalizeAddress } from '@shared/browserUrl'

function googleSearch(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`
}

/**
 * Turn an address-bar / start-page entry into a navigable http(s)/file URL, or a Google search
 * for free text. Returns null only for empty input. localhost/127.0.0.1 default to http (dev
 * servers); other bare hosts to https. file:// loads local pages; a non-localhost "host" in a
 * file URL (file://path/to/x) is folded into the path — on this local-only browser it can only
 * be a mistyped absolute path. Other schemes (javascript:/data:/…) are searched, never navigated.
 */
export function searchOrUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  // Explicit scheme. The negative lookahead keeps `host:port` (e.g. `localhost:3000`) out of the
  // scheme branch — a real URI scheme's colon is never immediately followed by a port digit.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw)) {
    if (/^https?:\/\//i.test(raw)) {
      try {
        return new URL(raw).toString()
      } catch {
        return googleSearch(raw)
      }
    }
    if (/^file:/i.test(raw)) {
      try {
        const u = new URL(raw)
        return u.host ? new URL(`file:///${u.host}${u.pathname}${u.search}${u.hash}`).toString() : u.toString()
      } catch {
        return googleSearch(raw)
      }
    }
    return googleSearch(raw)
  }
  // No scheme: is it a host?
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(raw)
  const looksHost = !/\s/.test(raw) && (isLocal || /^[^\s/]+\.[^\s/]+/.test(raw))
  if (looksHost) {
    try {
      return new URL(`${isLocal ? 'http' : 'https'}://${raw}`).toString()
    } catch {
      return googleSearch(raw)
    }
  }
  return googleSearch(raw)
}
