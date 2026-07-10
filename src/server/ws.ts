// Authenticated WebSocket endpoint for the Server Edition.
//
// Attaches a `WebSocketServer({ noServer: true })` to an existing http.Server and
// handles the `upgrade` event ONLY for path `/ws`. The upgrade is gated by the
// session cookie AND (when an Origin header is present) an Origin/Host same-host
// check that blocks cross-site WebSocket hijacking — native clients (curl/ws)
// without an Origin still pass the gate but must present a valid cookie.
//
// Once connected, each socket attaches to the ServerPlatform as one UI: text
// frames are parsed as RPC (req → dispatch → response; cast → cast; anything else
// ignored), and the platform pushes JSON events / binary pty frames back through
// the sink. Binary client→server frames are ignored in Phase 2 (pty input rides
// JSON casts). See task-5-brief.md.
import type http from 'http'
import type { Duplex } from 'stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Auth } from './auth'
import type { ServerPlatform } from './platform-server'
import { sessionTokenFromCookie } from './http'
import { parseRpcMessage } from '../shared/rpc'

export interface WsServerOpts {
  platform: ServerPlatform
  auth: Auth
}

/**
 * Decide whether an upgrade request is allowed. Returns true only when the
 * session cookie validates AND, if an Origin header is present, its host matches
 * the Host header. A malformed Origin URL is treated as a rejection (never throws).
 */
function upgradeAllowed(req: http.IncomingMessage, auth: Auth): boolean {
  const token = sessionTokenFromCookie(req.headers['cookie'])
  if (!auth.validateSession(token)) return false

  const origin = req.headers['origin']
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      // Malformed Origin → reject, don't throw.
      return false
    }
    if (originHost !== req.headers['host']) return false
  }
  return true
}

export function attachWsServer(server: http.Server, opts: WsServerOpts): void {
  const { platform, auth } = opts
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    // Only handle our path; a mismatched path is left for any other upgrade
    // listener (and, if none, the socket eventually times out / is destroyed by node).
    const pathname = new URL(req.url || '/', 'http://x').pathname
    if (pathname !== '/ws') return

    if (!upgradeAllowed(req, auth)) {
      // Guard the raw socket: writing to an already-dead peer emits 'error', and an
      // unhandled 'error' on a socket (EventEmitter) throws → crashes the process.
      socket.on('error', () => {})
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    const uiId = platform.attach({
      sendText: (json) => ws.send(json),
      sendBinary: (buf) => ws.send(buf, { binary: true })
    })

    ws.on('message', (data: unknown, isBinary: boolean) => {
      // Binary client→server frames are ignored in Phase 2 (pty input rides JSON casts).
      if (isBinary) return
      const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : String(data)
      const m = parseRpcMessage(text)
      if (!m) return
      if (m.t === 'req') {
        void platform.dispatch(uiId, m).then((res) => ws.send(JSON.stringify(res)))
      } else if (m.t === 'cast') {
        platform.cast(uiId, m.method, m.args)
      }
      // res/ev from a client are ignored.
    })

    // Without an 'error' listener, a receiver protocol error (malformed/unmasked
    // frame, corrupted proxy frame) emits 'error' on the socket with no listener,
    // which THROWS → uncaughtException → the whole server exits, tearing down every
    // session's pty. Log and let 'close' fire for this one connection only.
    ws.on('error', (e: NodeJS.ErrnoException) => {
      console.warn('[nodeterm-server] ws socket error', (e && e.code) || e)
    })

    ws.on('close', () => {
      platform.detach(uiId)
    })
  })
}
