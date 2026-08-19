// Address-bar normalization, in `src/shared` because BOTH shells need it: the renderer's address bar
// (re-exported from `renderer/nodes/browserUrl.ts`, so no existing import path changes) and main's
// CDP allowlist, whose `Page.navigate` validator reuses THIS scheme check rather than re-deriving it
// — one place decides "is this an http(s) URL", so the address bar and the allowlist can never drift
// into disagreeing about `javascript:`/`file:`/`data:`.

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
