// Plain node:http request handler for the server edition.
// Deliberately NOT Fastify: the handler surface is tiny (a handful of auth
// routes + static renderer serving), it must be embeddable in an existing
// http.Server the WS upgrade also attaches to (Task 5), and avoiding a
// framework keeps the dependency/attack surface minimal. See task-4-brief.md.
import http from 'http'
import fs from 'fs'
import path from 'path'
import type { Auth } from './auth'

export const SESSION_COOKIE = 'nt_session'

const MAX_BODY_BYTES = 10 * 1024 // 10KB POST body cap

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
}

// CSP served with the inline login/setup pages (no app assets, no connections).
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"

export interface HttpHandlerOpts {
  auth: Auth
  rendererDir: string
}

/** Parse the `nt_session=` value out of a Cookie header. Exported for the WS upgrade (Task 5). */
export function sessionTokenFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name === SESSION_COOKIE) return part.slice(eq + 1).trim()
  }
  return undefined
}

function isHtmlNavigation(req: http.IncomingMessage): boolean {
  const accept = req.headers['accept']
  return typeof accept === 'string' && accept.includes('text/html')
}

function cookieAttributes(req: http.IncomingMessage): string {
  let attrs = `HttpOnly; SameSite=Strict; Path=/`
  if (req.headers['x-forwarded-proto'] === 'https') attrs += '; Secure'
  return attrs
}

function setSessionCookie(req: http.IncomingMessage, res: http.ServerResponse, token: string): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieAttributes(req)}`)
}

function clearSessionCookie(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; ${cookieAttributes(req)}`)
}

function redirect(res: http.ServerResponse, status: number, location: string): void {
  res.writeHead(status, { Location: location })
  res.end()
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(s)
}

function sendPage(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': PAGE_CSP,
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(html)
}

/** Read a form-encoded POST body (capped) and decode into URLSearchParams. */
function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    req.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', (err) => {
      if (!aborted) reject(err)
    })
  })
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const PAGE_STYLE =
  "margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0d10;color:#e6e6e6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
const CARD_STYLE =
  'background:#16191d;border:1px solid #26292e;border-radius:12px;padding:32px;width:320px;box-shadow:0 10px 40px rgba(0,0,0,0.4)'
const INPUT_STYLE =
  'width:100%;box-sizing:border-box;margin:8px 0;padding:10px 12px;border-radius:8px;border:1px solid #33373d;background:#0b0d10;color:#e6e6e6;font-size:14px'
const BUTTON_STYLE =
  'width:100%;box-sizing:border-box;margin-top:12px;padding:10px 12px;border-radius:8px;border:none;background:#2f6feb;color:#fff;font-size:14px;font-weight:600;cursor:pointer'
const H1_STYLE = 'margin:0 0 4px;font-size:18px;font-weight:600'
const SUB_STYLE = 'margin:0 0 16px;font-size:13px;color:#9aa0a6'
const ERR_STYLE = 'margin:0 0 12px;font-size:13px;color:#f26d6d'

function loginPage(hasError: boolean): string {
  const errLine = hasError ? `<p style="${ERR_STYLE}">Wrong password. Try again.</p>` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in — nodeterm</title></head><body style="${PAGE_STYLE}"><form method="post" action="/auth/login" style="${CARD_STYLE}"><h1 style="${H1_STYLE}">nodeterm</h1><p style="${SUB_STYLE}">Sign in to continue</p>${errLine}<input style="${INPUT_STYLE}" type="password" name="password" placeholder="Password" autofocus autocomplete="current-password"><button style="${BUTTON_STYLE}" type="submit">Sign in</button></form></body></html>`
}

function setupPage(token: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Set up — nodeterm</title></head><body style="${PAGE_STYLE}"><form method="post" action="/auth/setup" style="${CARD_STYLE}"><h1 style="${H1_STYLE}">Welcome to nodeterm</h1><p style="${SUB_STYLE}">Choose a password to secure this server.</p><input type="hidden" name="token" value="${esc(token)}"><input style="${INPUT_STYLE}" type="password" name="password" placeholder="New password (min 8 chars)" autofocus autocomplete="new-password" minlength="8"><button style="${BUTTON_STYLE}" type="submit">Create password</button></form></body></html>`
}

/**
 * Resolve a URL path against the renderer root with traversal protection.
 * Returns the absolute file path, or null if it escapes the root.
 */
function resolveStaticPath(rendererDir: string, urlPath: string): string | null {
  // Decode percent-encoding so %2e%2e / %2f can't smuggle a traversal past the check.
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  // Normalize backslashes to forward slashes so Windows-style separators can't escape.
  decoded = decoded.replace(/\\/g, '/')
  if (decoded === '/' || decoded === '') decoded = '/index.html'
  // Strip the leading slash, then normalize. path.normalize collapses ../ segments.
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  const root = path.resolve(rendererDir)
  const candidate = path.resolve(root, '.' + (normalized.startsWith('/') ? normalized : '/' + normalized))
  // Containment check: the resolved path must be the root or sit under root + separator.
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null
  return candidate
}

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rendererDir: string,
  urlPath: string
): void {
  const filePath = resolveStaticPath(rendererDir, urlPath)
  if (!filePath) {
    sendJson(res, 400, { error: 'bad_path' })
    return
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    sendJson(res, 404, { error: 'not_found' })
    return
  }
  if (stat.isDirectory()) {
    sendJson(res, 404, { error: 'not_found' })
    return
  }
  const ext = path.extname(filePath).toLowerCase()
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream'
  let body: Buffer = fs.readFileSync(filePath)
  // CSP rewrite ONLY on index.html: relax connect-src so the WS client can connect.
  if (path.basename(filePath) === 'index.html') {
    const html = body.toString('utf8')
    const marker = "default-src 'self';"
    if (html.includes(marker)) {
      body = Buffer.from(html.replace(marker, "default-src 'self'; connect-src 'self' ws: wss:;"))
    } else {
      // A silent no-op here would leave the desktop CSP intact and the browser
      // would block the ws:/wss: WebSocket with no visible error — make sure an
      // operator sees this in the server logs.
      console.warn(
        "[nodeterm-server] index.html CSP did not contain the expected `default-src 'self';` marker — the ws: connect-src rewrite did not apply; the browser will block the WebSocket. Rebuild the renderer or update the rewrite."
      )
    }
  }
  res.writeHead(200, { 'Content-Type': contentType })
  res.end(body)
}

export function createHttpHandler(
  opts: HttpHandlerOpts
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const { auth, rendererDir } = opts

  return function handler(req: http.IncomingMessage, res: http.ServerResponse): void {
    void handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
      else res.end()
    })
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://x')
    const pathname = url.pathname
    const method = req.method || 'GET'

    // ---- Public auth routes (no session required) --------------------------

    if (pathname === '/setup' && method === 'GET') {
      if (auth.isConfigured()) {
        sendPage(res, 403, '<!doctype html><title>403</title><p style="color:#fff">Already configured.</p>')
        return
      }
      sendPage(res, 200, setupPage(auth.setupToken()))
      return
    }

    if (pathname === '/login' && method === 'GET') {
      if (!auth.isConfigured()) {
        redirect(res, 302, '/setup')
        return
      }
      sendPage(res, 200, loginPage(url.searchParams.has('error')))
      return
    }

    if (pathname === '/auth/setup' && method === 'POST') {
      // Gate on !isConfigured FIRST: setupToken() regenerates a fresh token once
      // consumed, so we must never touch consumeSetupToken when already configured.
      if (auth.isConfigured()) {
        sendJson(res, 403, { error: 'already_configured' })
        return
      }
      let form: URLSearchParams
      try {
        form = await readForm(req)
      } catch {
        sendJson(res, 400, { error: 'bad_request' })
        return
      }
      const token = form.get('token') || ''
      const password = form.get('password') || ''
      if (password.length < 8 || !auth.consumeSetupToken(token)) {
        sendJson(res, 403, { error: 'invalid_setup' })
        return
      }
      auth.setPassword(password)
      const session = auth.createSession()
      setSessionCookie(req, res, session)
      redirect(res, 303, '/')
      return
    }

    if (pathname === '/auth/login' && method === 'POST') {
      if (!auth.loginAllowed()) {
        sendJson(res, 429, { error: 'too_many_attempts' })
        return
      }
      let form: URLSearchParams
      try {
        form = await readForm(req)
      } catch {
        sendJson(res, 400, { error: 'bad_request' })
        return
      }
      const password = form.get('password') || ''
      if (auth.verifyPassword(password)) {
        auth.recordLoginSuccess()
        const session = auth.createSession()
        setSessionCookie(req, res, session)
        redirect(res, 303, '/')
        return
      }
      auth.recordLoginFailure()
      redirect(res, 303, '/login?error=1')
      return
    }

    if (pathname === '/auth/logout' && method === 'POST') {
      clearSessionCookie(req, res)
      redirect(res, 303, '/login')
      return
    }

    // ---- Everything else requires a valid session --------------------------

    const token = sessionTokenFromCookie(req.headers['cookie'])
    if (!auth.validateSession(token)) {
      if (isHtmlNavigation(req)) redirect(res, 302, '/login')
      else sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    // Authenticated: serve static renderer files (index.html fallback for '/').
    serveStatic(req, res, rendererDir, pathname)
  }
}
