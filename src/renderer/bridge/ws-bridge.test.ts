import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import { WebSocketServer } from 'ws'
import WebSocket from 'ws'
import { encodePtyData } from '../../shared/rpc'

// RpcClient is exported for tests
import { RpcClient } from './ws-bridge'

let server: http.Server, wss: WebSocketServer, port: number

beforeEach(async () => {
  ;(globalThis as Record<string, unknown>).WebSocket = WebSocket
  server = http.createServer()
  wss = new WebSocketServer({ server })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})
afterEach(async () => {
  // Terminate the live client socket(s) first: an upgraded WebSocket connection is detached
  // from the http server's connection tracking, so `wss.close()` alone leaves the socket open
  // and `server.close()` would block forever waiting for it. (Test-infra cleanup only — the
  // assertions above are unchanged.)
  for (const c of wss.clients) c.terminate()
  wss.close()
  await new Promise((r) => server.close(r))
})

describe('RpcClient', () => {
  it('settles requests from responses and fans out JSON + binary events', async () => {
    wss.on('connection', (sock) => {
      sock.on('message', (d, isBinary) => {
        if (isBinary) return
        const m = JSON.parse(d.toString())
        if (m.t === 'req') sock.send(JSON.stringify({ t: 'res', id: m.id, ok: true, result: m.args[0] }))
      })
      sock.send(JSON.stringify({ t: 'ev', channel: 'pty:exit:s1', args: [0] }))
      sock.send(encodePtyData('s1', 'hello'), { binary: true })
    })
    const client = new RpcClient(`ws://127.0.0.1:${port}/`)
    await client.ready()
    const exits: unknown[] = []
    const datas: string[] = []
    client.subscribe('pty:exit:s1', (code) => exits.push(code))
    client.subscribe('pty:data:s1', (d) => datas.push(d as string))
    expect(await client.request('any:method', 'ping')).toBe('ping')
    await new Promise((r) => setTimeout(r, 200))
    expect(exits).toEqual([0])
    expect(datas).toEqual(['hello'])
  })

  it('rejects pending requests with the coded error from an err response', async () => {
    wss.on('connection', (sock) => {
      sock.on('message', (d) => {
        const m = JSON.parse(d.toString())
        sock.send(JSON.stringify({ t: 'res', id: m.id, ok: false, error: { code: 'E_NO_HANDLER', message: 'nope' } }))
      })
    })
    const client = new RpcClient(`ws://127.0.0.1:${port}/`)
    await client.ready()
    await expect(client.request('missing')).rejects.toMatchObject({ code: 'E_NO_HANDLER' })
  })
})
