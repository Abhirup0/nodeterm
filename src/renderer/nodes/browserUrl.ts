// Normalize an address-bar entry into an http(s) URL, or null when it can't be one.
// Blocks file:/javascript:/data:/custom schemes; adds https:// to a bare host. No search fallback.
export function normalizeAddress(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  // Already a URL with a scheme?
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    try {
      const u = new URL(raw)
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
    } catch {
      return null
    }
  }
  // No scheme: only treat as a host if it has a dot and no spaces.
  if (/\s/.test(raw) || !raw.includes('.')) return null
  try {
    const u = new URL(`https://${raw}`)
    return u.toString()
  } catch {
    return null
  }
}

function googleSearch(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`
}

/**
 * Turn an address-bar / start-page entry into a navigable http(s) URL, or a Google search for
 * free text. Returns null only for empty input. localhost/127.0.0.1 default to http (dev servers);
 * other bare hosts to https. Non-http schemes (file:/javascript:/…) are searched, never navigated.
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
