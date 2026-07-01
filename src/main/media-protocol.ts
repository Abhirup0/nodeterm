// nt-media:// — a privileged streaming protocol for local media (video) + large images.
// Files are served ONLY if they are on the per-session allowlist (path jail), so the
// renderer/agent can never read an arbitrary local file. Supports HTTP Range so <video> seeks.
import { createReadStream, statSync, lstatSync, mkdirSync, writeFileSync } from 'fs'
import { normalize } from 'path'
import { app, protocol } from 'electron'

export const MEDIA_SCHEME = 'nt-media'

// Absolute paths the app has explicitly opened this session. Cleared only on quit.
const allowed = new Set<string>()

/** Build the nt-media:// URL for an absolute path (path encoded as the URL pathname). */
export function mediaUrlFor(absPath: string): string {
  // Encode each path segment individually so reserved chars (?, #, &) round-trip through
  // the URL pathname (encodeURI leaves them, which would break the pathname match). The
  // decode side (resolveMediaPath → decodeURIComponent) stays symmetric.
  const pathname = absPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  return `${MEDIA_SCHEME}://media${pathname}`
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

/**
 * Register the path (so the protocol will serve it) and return its nt-media:// URL.
 * Allowlist registration is renderer-trusted (same trust boundary as the existing
 * `fs:read-binary` IPC), so this intentionally accepts any absolute path; the serve-time
 * lexical jail + symlink check in `initMediaProtocol` are the boundary.
 */
export function allowMediaPath(absPath: string): string {
  const norm = normalize(absPath)
  allowed.add(norm)
  return mediaUrlFor(norm)
}

/** The per-session directory holding agent-authored HTML (served under a restrictive CSP). */
function agentWebDir(): string {
  return `${app.getPath('userData')}/agent-web`
}

// Restrictive CSP for agent-authored HTML: render + inline scripts/styles/media, but NO
// network requests and NO fetching other nt-media files (so it can't exfiltrate or read
// sibling allowlisted files).
const AGENT_HTML_CSP =
  "default-src 'none'; img-src nt-media: data:; media-src nt-media:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:"

let htmlSeq = 0
/** Write raw HTML to a per-session file under userData, allowlist it, return its abs path. */
export function writeAgentHtml(html: string): string {
  const d = agentWebDir()
  mkdirSync(d, { recursive: true })
  const p = `${d}/${Date.now().toString(36)}-${++htmlSeq}.html`
  writeFileSync(p, html, { encoding: 'utf8', mode: 0o600 })
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
    // Symlink jail: reject a final-component symlink so an allowlisted entry can't be
    // turned into an arbitrary-file read. lstat does NOT follow the final link (it follows
    // intermediate dir symlinks like macOS /tmp→/private/tmp, which is fine and avoids the
    // realpath-equality pitfalls with those system dirs).
    try {
      if (lstatSync(abs).isSymbolicLink()) return new Response('Not found', { status: 404 })
    } catch {
      return new Response('Not found', { status: 404 })
    }
    let size: number
    try {
      size = statSync(abs).size
    } catch {
      return new Response('Not found', { status: 404 })
    }
    // Agent-authored HTML gets a restrictive CSP; video/image files get none (unchanged).
    const isAgentHtml = abs.startsWith(agentWebDir() + '/')
    const range = req.headers.get('range')
    const m = range && /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0
      let end = m[2] ? parseInt(m[2], 10) : size - 1
      // Unsatisfiable range → 416 (NaN/negative start or start past EOF).
      if (!Number.isFinite(start) || start < 0 || start >= size) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` }
        })
      }
      end = Math.min(end, size - 1)
      const stream = createReadStream(abs, { start, end })
      stream.on('error', () => stream.destroy())
      const headers: Record<string, string> = {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1)
      }
      if (isAgentHtml) headers['Content-Security-Policy'] = AGENT_HTML_CSP
      return new Response(stream as unknown as ReadableStream, { status: 206, headers })
    }
    const stream = createReadStream(abs)
    stream.on('error', () => stream.destroy())
    const headers: Record<string, string> = {
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes'
    }
    if (isAgentHtml) headers['Content-Security-Policy'] = AGENT_HTML_CSP
    return new Response(stream as unknown as ReadableStream, { status: 200, headers })
  })
}
