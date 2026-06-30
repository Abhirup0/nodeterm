// nt-media:// — a privileged streaming protocol for local media (video) + large images.
// Files are served ONLY if they are on the per-session allowlist (path jail), so the
// renderer/agent can never read an arbitrary local file. Supports HTTP Range so <video> seeks.
import { createReadStream, statSync, mkdirSync, writeFileSync } from 'fs'
import { normalize } from 'path'
import { app, protocol } from 'electron'

export const MEDIA_SCHEME = 'nt-media'

// Absolute paths the app has explicitly opened this session. Cleared only on quit.
const allowed = new Set<string>()

/** Build the nt-media:// URL for an absolute path (path encoded as the URL pathname). */
export function mediaUrlFor(absPath: string): string {
  // Use the path as an opaque, percent-encoded pathname under a fixed host.
  return `${MEDIA_SCHEME}://media${encodeURI(absPath)}`
}

/**
 * Pure jail check: decode the request pathname, normalize it, and return it only if the
 * normalized absolute path is on `allow`. Returns null otherwise (unknown path or traversal
 * that resolves outside the allowlist).
 */
export function resolveMediaPath(requestPath: string, allow: ReadonlySet<string>): string | null {
  let p: string
  try {
    p = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  const norm = normalize(p)
  return allow.has(norm) ? norm : null
}

/** Register the path (so the protocol will serve it) and return its nt-media:// URL. */
export function allowMediaPath(absPath: string): string {
  const norm = normalize(absPath)
  allowed.add(norm)
  return mediaUrlFor(norm)
}

let htmlSeq = 0
/** Write raw HTML to a per-session file under userData, allowlist it, return its abs path. */
export function writeAgentHtml(html: string): string {
  const d = `${app.getPath('userData')}/agent-web`
  mkdirSync(d, { recursive: true })
  const p = `${d}/${Date.now().toString(36)}-${++htmlSeq}.html`
  writeFileSync(p, html, 'utf8')
  allowMediaPath(p)
  return p
}

/** Call BEFORE app.whenReady(): declares the scheme privileged (secure + streamable). */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
    }
  ])
}

/** Call AFTER app is ready: serve allowed files with Range support. */
export function initMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (req) => {
    const url = new URL(req.url)
    const abs = resolveMediaPath(url.pathname, allowed)
    if (!abs) return new Response('Not found', { status: 404 })
    let size: number
    try {
      size = statSync(abs).size
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const range = req.headers.get('range')
    const m = range && /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0
      const end = m[2] ? parseInt(m[2], 10) : size - 1
      const stream = createReadStream(abs, { start, end })
      return new Response(stream as unknown as ReadableStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start + 1)
        }
      })
    }
    const stream = createReadStream(abs)
    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: { 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
    })
  })
}
