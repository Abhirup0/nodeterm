import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { Auth } from './auth'
import { ServerPlatform } from './platform-server'
import { attachWsServer } from './ws'
import { SESSION_COOKIE } from './http'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { presenceHub } from '../core/presence/hub'
import { IPC } from '../shared/ipc'

let dir: string, server: http.Server, port: number, auth: Auth, platform: ServerPlatform, cookie: string
/** Every socket this file opens, so afterEach can tear them all down (see below). */
let sockets: WebSocket[] = []

/** Poll until `pred` holds (or throw after ~2s) — socket teardown is async. */
async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-ws-'))
  auth = new Auth(dir)
  platform = new ServerPlatform({ userDataDir: dir, appVersion: '0.0.0' })
  // The connection handler joins the presence hub, and the hub reaches its shell through the
  // core platform singleton — so this unit test must install the platform, exactly as boot does.
  initPlatform(platform)
  server = http.createServer((_q, s) => { s.statusCode = 404; s.end() })
  attachWsServer(server, { platform, auth })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
  cookie = `${SESSION_COOKIE}=${auth.createSession()}`
  sockets = []
})
afterEach(async () => {
  // Tear the sockets down BEFORE the platform, and wait for the server side to notice. The
  // presence hub is a process-wide singleton while each test builds a fresh ServerPlatform whose
  // uiIds restart at 1 — so a socket whose 'close' (→ presenceHub.leave(uiId)) lands after the
  // test boundary would leave/join against the NEXT test's peers. Draining the hub is the
  // authoritative signal that every server-side 'close' handler has run.
  for (const ws of sockets) ws.terminate()
  sockets = []
  await until(() => presenceHub.peers().length === 0, 'presence hub drains')
  await new Promise((r) => server.close(r))
  // Safe now: no socket, so no late callback can reach a torn-out platform.
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Text frames each socket received, recorded from before 'open' so nothing pushed at connect
 *  time (presence:sync) can be missed by a listener attached one tick too late. */
const recorded = new WeakMap<WebSocket, string[]>()
function received(ws: WebSocket): string[] {
  return recorded.get(ws) ?? []
}

function connect(headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers })
    sockets.push(ws)
    const rec: string[] = []
    recorded.set(ws, rec)
    ws.on('message', (d, isBinary) => { if (!isBinary) rec.push(d.toString()) })
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

describe('ws endpoint', () => {
  it('rejects without a valid session cookie and with a cross-site Origin', async () => {
    await expect(connect({})).rejects.toThrow()
    await expect(connect({ cookie: `${SESSION_COOKIE}=bogus` })).rejects.toThrow()
    await expect(
      connect({ cookie, origin: 'https://evil.example.com' })
    ).rejects.toThrow()
  })

  it('accepts a valid cookie (same-host Origin ok), dispatches req and cast, pushes events', async () => {
    platform.handle('echo:x', (v: string) => `got:${v}`)
    const casts: unknown[] = []
    platform.on('fire', (v: unknown) => casts.push(v))
    const ws = await connect({ cookie, origin: `http://127.0.0.1:${port}` })
    const messages: string[] = []
    ws.on('message', (d, isBinary) => { if (!isBinary) messages.push(d.toString()) })

    ws.send(JSON.stringify({ t: 'req', id: 7, method: 'echo:x', args: ['hi'] }))
    ws.send(JSON.stringify({ t: 'cast', method: 'fire', args: [123] }))
    await new Promise((r) => setTimeout(r, 200))
    expect(messages.map((m) => JSON.parse(m))).toContainEqual({
      t: 'res', id: 7, ok: true, result: 'got:hi'
    })
    expect(casts).toEqual([123])

    // server push (JSON event + binary pty frame) reaches the client
    const bins: Buffer[] = []
    ws.on('message', (d, isBinary) => { if (isBinary) bins.push(d as Buffer) })
    platform.broadcast('pty:exit:s9', 0)
    platform.broadcast('pty:data:s9', 'chunk')
    await new Promise((r) => setTimeout(r, 200))
    expect(messages.map((m) => JSON.parse(m))).toContainEqual({
      t: 'ev', channel: 'pty:exit:s9', args: [0]
    })
    expect(bins.length).toBe(1)
    ws.close()
  })

  it('survives a receiver protocol error on one connection; others keep working', async () => {
    platform.handle('echo:x', (v: string) => `got:${v}`)
    const ws1 = await connect({ cookie, origin: `http://127.0.0.1:${port}` })
    const ws2 = await connect({ cookie, origin: `http://127.0.0.1:${port}` })
    // Swallow the expected client-side error when the server closes ws1's bad frame.
    ws1.on('error', () => {})

    // Corrupt ws1: write a raw UNMASKED text frame straight to its TCP socket.
    // RFC 6455 requires client→server frames to be masked, so the server's receiver
    // emits 'error' — which, without our listener, would throw and exit the process.
    // 0x81 = FIN+text, 0x00 = mask bit unset + length 0.
    ;(ws1 as unknown as { _socket: NodeJS.WritableStream })._socket.write(
      Buffer.from([0x81, 0x00])
    )
    await new Promise((r) => setTimeout(r, 100))

    // The process is still alive and ws2 round-trips a request.
    const messages: string[] = []
    ws2.on('message', (d, isBinary) => { if (!isBinary) messages.push(d.toString()) })
    ws2.send(JSON.stringify({ t: 'req', id: 9, method: 'echo:x', args: ['ok'] }))
    await new Promise((r) => setTimeout(r, 200))
    expect(messages.map((m) => JSON.parse(m))).toContainEqual({
      t: 'res', id: 9, ok: true, result: 'got:ok'
    })
    ws1.close()
    ws2.close()
  })

  // An ORDERED PAIR guarding afterEach's teardown. The presence hub is process-wide, but each test
  // builds a fresh ServerPlatform whose uiIds restart at 1 — so a socket outliving its test would
  // either leave() the next test's first peer or make its join() hit the hub's already-present
  // early return (and that socket would then never get presence:sync). The first test deliberately
  // abandons its socket; the second asserts the next test still starts clean.
  it('joins the presence hub (socket deliberately left open for the next test)', async () => {
    await connect({ cookie })
    await until(() => presenceHub.peers().length === 1, 'the socket joins the hub')
  })

  it('starts with an empty hub, and its first socket receives its own presence:sync', async () => {
    expect(presenceHub.peers()).toHaveLength(0)
    const ws = await connect({ cookie })
    await until(
      () => received(ws).some((m) => JSON.parse(m).channel === IPC.presenceSync),
      'presence:sync on connect'
    )
    ws.close()
  })
})
