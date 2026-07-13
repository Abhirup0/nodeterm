import { describe, it, expect, vi } from 'vitest'
import {
  createClientHandlers,
  type ClientRelaySocket,
  type ClientSessionSinks
} from '../../src/main/remote/client-service'
import { OP } from '../../src/main/remote/framing'

// A fake relay socket that records RPC calls (resolving them on demand) and frames sent.
function fakeSocket(createBody: unknown = { streamId: 7 }) {
  const rpcs: { method: string; params: unknown }[] = []
  const frames: { op: number; streamId: number; seq: number; payload: Uint8Array }[] = []
  const socket: ClientRelaySocket = {
    rpc: vi.fn(async (method, params) => {
      rpcs.push({ method, params })
      // RemoteTransport is remote-only, so `create` maps to `pty.attach` (attach-to-existing).
      if (method === 'pty.attach') return createBody
      return {}
    }),
    sendFrame: vi.fn((op, streamId, seq, payload) => {
      frames.push({ op, streamId, seq, payload })
      return true
    })
  }
  return { socket, rpcs, frames }
}

function fakeSinks() {
  const data: { streamId: number; data: string }[] = []
  const exits: { streamId: number; exitCode: number }[] = []
  const sinks: ClientSessionSinks = {
    onData: (streamId, d) => data.push({ streamId, data: d }),
    onExit: (streamId, exitCode) => exits.push({ streamId, exitCode })
  }
  return { sinks, data, exits }
}

describe('createClientHandlers', () => {
  it('maps create to RPC pty.attach (nodeId from persistKey) and resolves with the host streamId', async () => {
    const sock = fakeSocket({ streamId: 7 })
    const sinks = fakeSinks()
    const h = createClientHandlers(sock.socket, sinks.sinks)

    const streamId = await h.create({ cols: 100, rows: 30, cwd: '/tmp', persistKey: 'node-9' })

    expect(streamId).toBe(7)
    expect(sock.rpcs).toEqual([
      { method: 'pty.attach', params: { nodeId: 'node-9', cols: 100, rows: 30 } }
    ])
  })

  it('delivers a buffered snapshot (Start→Chunk*→End) as the first onData before live output', async () => {
    const sock = fakeSocket({ streamId: 4 })
    const sinks = fakeSinks()
    const h = createClientHandlers(sock.socket, sinks.sinks)
    await h.create({ cols: 80, rows: 24, persistKey: 'node-x' })

    h.onFrame({ op: OP.SnapshotStart, streamId: 4, seq: 0, payload: new Uint8Array(0) })
    h.onFrame({ op: OP.SnapshotChunk, streamId: 4, seq: 1, payload: new TextEncoder().encode('cur') })
    h.onFrame({ op: OP.SnapshotChunk, streamId: 4, seq: 2, payload: new TextEncoder().encode('rent') })
    // Nothing delivered until End.
    expect(sinks.data).toEqual([])
    h.onFrame({ op: OP.SnapshotEnd, streamId: 4, seq: 3, payload: new Uint8Array(0) })
    // Snapshot first, then live output.
    h.onFrame({ op: OP.Output, streamId: 4, seq: 4, payload: new TextEncoder().encode('live') })

    expect(sinks.data).toEqual([
      { streamId: 4, data: 'current' },
      { streamId: 4, data: 'live' }
    ])
  })

  it('throws when the host does not return a numeric streamId', async () => {
    const sock = fakeSocket({})
    const h = createClientHandlers(sock.socket, fakeSinks().sinks)
    await expect(h.create({ cols: 80, rows: 24 })).rejects.toThrow(/streamId/)
  })

  it('sends OP.Input frames for write with an incrementing seq', async () => {
    const sock = fakeSocket({ streamId: 3 })
    const h = createClientHandlers(sock.socket, fakeSinks().sinks)
    await h.create({ cols: 80, rows: 24 })

    h.write(3, 'ls\n')
    h.write(3, 'pwd\n')

    expect(sock.frames).toHaveLength(2)
    expect(sock.frames[0]).toMatchObject({ op: OP.Input, streamId: 3, seq: 0 })
    expect(Buffer.from(sock.frames[0].payload).toString('utf8')).toBe('ls\n')
    expect(sock.frames[1]).toMatchObject({ op: OP.Input, streamId: 3, seq: 1 })
  })

  it('sends OP.Resize frames as 2x uint16 LE (cols, rows)', async () => {
    const sock = fakeSocket({ streamId: 1 })
    const h = createClientHandlers(sock.socket, fakeSinks().sinks)
    await h.create({ cols: 80, rows: 24 })

    h.resize(1, 120, 40)

    expect(sock.frames).toHaveLength(1)
    const f = sock.frames[0]
    expect(f.op).toBe(OP.Resize)
    const view = new DataView(f.payload.buffer, f.payload.byteOffset, f.payload.byteLength)
    expect(view.getUint16(0, true)).toBe(120)
    expect(view.getUint16(2, true)).toBe(40)
  })

  it('ignores write/resize for unknown streams', async () => {
    const sock = fakeSocket()
    const h = createClientHandlers(sock.socket, fakeSinks().sinks)
    h.write(99, 'x')
    h.resize(99, 10, 10)
    expect(sock.frames).toHaveLength(0)
  })

  it('routes OP.Output frames to onData', async () => {
    const sock = fakeSocket({ streamId: 5 })
    const sinks = fakeSinks()
    const h = createClientHandlers(sock.socket, sinks.sinks)
    await h.create({ cols: 80, rows: 24 })

    h.onFrame({ op: OP.Output, streamId: 5, seq: 0, payload: new TextEncoder().encode('hello') })

    expect(sinks.data).toEqual([{ streamId: 5, data: 'hello' }])
  })

  it('routes OP.Error frames to onExit, parses {exitCode}, and drops the stream', async () => {
    const sock = fakeSocket({ streamId: 2 })
    const sinks = fakeSinks()
    const h = createClientHandlers(sock.socket, sinks.sinks)
    await h.create({ cols: 80, rows: 24 })

    h.onFrame({
      op: OP.Error,
      streamId: 2,
      seq: 0,
      payload: new TextEncoder().encode(JSON.stringify({ exitCode: 42 }))
    })

    expect(sinks.exits).toEqual([{ streamId: 2, exitCode: 42 }])
    // After exit the stream is forgotten → further writes are ignored.
    h.write(2, 'x')
    expect(sock.frames).toHaveLength(0)
  })

  it('kill sends RPC pty.kill and forgets the stream', async () => {
    const sock = fakeSocket({ streamId: 9 })
    const h = createClientHandlers(sock.socket, fakeSinks().sinks)
    await h.create({ cols: 80, rows: 24 })

    h.kill(9)
    expect(sock.rpcs).toContainEqual({ method: 'pty.kill', params: { streamId: 9 } })

    // After kill, input for the dropped stream is ignored.
    h.write(9, 'x')
    expect(sock.frames).toHaveLength(0)
  })

  it('ignores frames for unknown streams', () => {
    const sock = fakeSocket()
    const sinks = fakeSinks()
    const h = createClientHandlers(sock.socket, sinks.sinks)
    h.onFrame({ op: OP.Output, streamId: 1, seq: 0, payload: new TextEncoder().encode('x') })
    expect(sinks.data).toHaveLength(0)
  })
})
