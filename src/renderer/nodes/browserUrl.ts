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
