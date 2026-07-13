import { describe, it, expect } from 'vitest'
import { encodePtyData, E_DISCONNECTED } from '../../shared/rpc'
import type { FrameTransport } from './frame-transport'
import { RpcClient } from './ws-bridge'

/**
 * An in-memory `FrameTransport` double. It records what the RpcClient sends, lets the test push
 * inbound frames (JSON strings OR binary `Uint8Array` pty-data), and can fire `close`. `ready`
 * resolves immediately — the carrier is "open" the moment it is constructed. This proves the
 * RpcClient depends only on the FrameTransport seam, never on a WebSocket.
 */
class FakeTransport implements FrameTransport {
  sent: string[] = []
  private msgCb: ((data: string | Uint8Array) => void) | null = null
  private closeCb: (() => void) | null = null

  send(json: string): void {
    this.sent.push(json)
  }
  onMessage(cb: (data: string | Uint8Array) => void): void {
    this.msgCb = cb
  }
  onClose(cb: () => void): void {
    this.closeCb = cb
  }
  ready(): Promise<void> {
    return Promise.resolve()
  }

  // Test drivers ─────────────────────────────────────────────────────────────
  emit(data: string | Uint8Array): void {
    this.msgCb?.(data)
  }
  drop(): void {
    this.closeCb?.()
  }
}

describe('RpcClient over a FrameTransport', () => {
  it('resolves a request on a matching res frame', async () => {
    const t = new FakeTransport()
    const client = new RpcClient(t)
    await client.ready()
    const p = client.request('any:method', 'ping')
    // The RpcClient assigned id 1 (first request).
    const frame = JSON.parse(t.sent[0])
    expect(frame).toMatchObject({ t: 'req', id: 1, method: 'any:method', args: ['ping'] })
    t.emit(JSON.stringify({ t: 'res', id: frame.id, ok: true, result: 'pong' }))
    expect(await p).toBe('pong')
  })

  it('fans out a JSON ev frame to subscribers', () => {
    const t = new FakeTransport()
    const client = new RpcClient(t)
    const seen: unknown[] = []
    client.subscribe('pty:exit:s1', (code) => seen.push(code))
    t.emit(JSON.stringify({ t: 'ev', channel: 'pty:exit:s1', args: [0] }))
    expect(seen).toEqual([0])
  })

  it('fans out a binary pty:data frame on ptyData(sessionId)', () => {
    const t = new FakeTransport()
    const client = new RpcClient(t)
    const datas: string[] = []
    client.subscribe('pty:data:s1', (d) => datas.push(d as string))
    t.emit(encodePtyData('s1', 'hello'))
    expect(datas).toEqual(['hello'])
  })

  it('rejects in-flight requests with E_DISCONNECTED when the transport closes', async () => {
    const t = new FakeTransport()
    const client = new RpcClient(t)
    await client.ready()
    const a = client.request('git:worktree-add', '/repo')
    t.drop()
    await expect(a).rejects.toMatchObject({ code: E_DISCONNECTED })
  })

  it('notifies onClose hooks when the transport closes', async () => {
    const t = new FakeTransport()
    const client = new RpcClient(t)
    let closed = 0
    client.onClose(() => closed++)
    t.drop()
    expect(closed).toBe(1)
  })
})
