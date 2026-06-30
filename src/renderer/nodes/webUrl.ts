/** Returns the URL string if it is an http(s) URL, else null (blocks file:/javascript:/data:/custom schemes). */
export function httpUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}
