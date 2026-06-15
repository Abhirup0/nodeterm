// Fetches the remote announcements feed from the website. Runs in the main process
// (Node) so the renderer's Content-Security-Policy stays locked to 'self' — the
// renderer asks for the data over IPC instead of making a cross-origin request.
import type { Announcement } from '../shared/types'

const FEED_URL = 'https://nodeterm.dev/announcements.json'
const TIMEOUT_MS = 8000

function isAnnouncement(x: unknown): x is Announcement {
  if (!x || typeof x !== 'object') return false
  const a = x as Record<string, unknown>
  return typeof a.id === 'string' && typeof a.title === 'string'
}

export async function fetchAnnouncements(): Promise<Announcement[]> {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    const res = await fetch(FEED_URL, { signal: ctrl.signal, cache: 'no-cache' }).finally(() =>
      clearTimeout(t)
    )
    if (!res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data)) return []
    // Keep only well-formed items and sanitize the optional link scheme.
    return data.filter(isAnnouncement).map((a) => ({
      id: a.id,
      title: a.title,
      body: typeof a.body === 'string' ? a.body : undefined,
      url: typeof a.url === 'string' && /^https?:\/\//.test(a.url) ? a.url : undefined,
      level: a.level === 'success' || a.level === 'warning' ? a.level : 'info'
    }))
  } catch {
    return []
  }
}
