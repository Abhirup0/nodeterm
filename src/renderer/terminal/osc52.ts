// Parse an OSC 52 payload (`<selection>;<base64>`) into clipboard text. WRITE-ONLY: a `?` read
// query is ignored (never expose the local clipboard to remote programs). Returns null on a read
// query / empty / malformed / oversized payload.
const MAX_BASE64 = 1_000_000

export function parseOsc52(data: string): string | null {
  const i = data.indexOf(';')
  if (i < 0) return null
  const payload = data.slice(i + 1)
  if (!payload || payload === '?' || payload.length > MAX_BASE64) return null
  try {
    const bin = atob(payload)
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text
  } catch {
    return null
  }
}
