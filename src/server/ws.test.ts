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

let dir: string, server: http.Server, port: number, auth: Auth, platform: ServerPlatform, cookie: string

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-ws-'))
  auth = new Auth(dir)
  platform = new ServerPlatform({ userDataDir: dir, appVersion: '0.0.0' })
  server = http.createServer((_q, s) => { s.statusCode = 404; s.end() })
  attachWsServer(server, { platform, auth })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
  cookie = `${SESSION_COOKIE}=${auth.createSession()}`
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
  fs.rmSync(dir, { recursive: true, force: true })
})

function connect(headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers })
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
})
