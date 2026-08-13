// The app-server protocol client, against a real WebSocket server on a real unix socket.
//
// Two of its answers are load-bearing in ways a mocked test would not show: `codexThreadExistsAt`
// is what stands between a stale session id and a node that dies AFTER exec (where no fallback is
// left), and both readers must answer the conservative thing when the server is simply not there —
// which, for a CLI whose app-server starts on demand, is a completely ordinary state.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  codexThreadExistsAt,
  codexUnixWebSocketUrl,
  readCodexSessionNameAt
} from './codex-session-name'

let dir = ''
let sock = ''
let server: http.Server
let wss: WebSocketServer
/** Threads the fake app-server knows about, id → name. */
const threads = new Map<string, string | null>([
  ['thread-known', 'Named by codex'],
  ['thread-nameless', null]
])
let initializeFails = false

function handle(ws: WebSocket): void {
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as Record<string, any>
    if (msg.method === 'initialize') {
      ws.send(
        JSON.stringify(
          initializeFails
            ? { id: msg.id, error: { message: 'not authenticated' } }
            : { id: msg.id, result: {} }
        )
      )
      return
    }
    if (msg.method === 'thread/read') {
      const id = msg.params?.threadId as string
      if (!threads.has(id)) {
        ws.send(JSON.stringify({ id: msg.id, error: { message: 'no rollout found' } }))
        return
      }
      ws.send(JSON.stringify({ id: msg.id, result: { thread: { id, name: threads.get(id) } } }))
    }
  })
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-appserver-'))
  sock = path.join(dir, 'app-server-control.sock')
  server = http.createServer()
  wss = new WebSocketServer({ server })
  wss.on('connection', handle)
  await new Promise<void>((resolve) => server.listen(sock, resolve))
})

afterAll(async () => {
  await new Promise<void>((resolve) => wss.close(() => resolve()))
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('codexThreadExistsAt', () => {
  it('confirms a thread the app-server knows', async () => {
    expect(await codexThreadExistsAt(sock, 'thread-known')).toBe(true)
    expect(await codexThreadExistsAt(sock, 'thread-nameless')).toBe(true)
  })

  it('refuses an id the app-server never heard of (the stale-session-id case)', async () => {
    // This is the whole point: the launcher's bind falls back to plain codex instead of exec'ing
    // a resume that dies with "no rollout found" where nothing can catch it.
    expect(await codexThreadExistsAt(sock, 'thread-from-a-past-life')).toBe(false)
  })

  it('refuses when the app-server is not running at all', async () => {
    expect(await codexThreadExistsAt(path.join(dir, 'nope.sock'), 'thread-known', 500)).toBe(false)
  })

  it('refuses an id that is not shaped like one, without opening a socket', async () => {
    expect(await codexThreadExistsAt(sock, '../../etc/passwd')).toBe(false)
  })

  it('refuses when the server will not initialize (a logged-out CLI)', async () => {
    initializeFails = true
    try {
      expect(await codexThreadExistsAt(sock, 'thread-known')).toBe(false)
    } finally {
      initializeFails = false
    }
  })
})

describe('readCodexSessionNameAt', () => {
  it("reads the thread's own name", async () => {
    expect(await readCodexSessionNameAt(sock, 'thread-known')).toBe('Named by codex')
  })

  it('answers null for a nameless or unknown thread, and for a dead server', async () => {
    // Null means "the node keeps its own title" — never a wrong one.
    expect(await readCodexSessionNameAt(sock, 'thread-nameless')).toBeNull()
    expect(await readCodexSessionNameAt(sock, 'thread-from-a-past-life')).toBeNull()
    expect(await readCodexSessionNameAt(path.join(dir, 'nope.sock'), 'thread-known', 500)).toBeNull()
  })
})

describe('codexUnixWebSocketUrl', () => {
  it('refuses a socket path that could not survive being put in a URL', () => {
    expect(() => codexUnixWebSocketUrl('relative/app-server.sock')).toThrow()
    expect(() => codexUnixWebSocketUrl('/tmp/with space/app.sock')).toThrow()
    expect(() => codexUnixWebSocketUrl('/tmp/a?b/app.sock')).toThrow()
  })
})
