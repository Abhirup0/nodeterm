import { describe, it, expect, vi } from 'vitest'
import {
  createHostHandlers,
  type HostPtyManager,
  type HostRelaySocket
} from '../../src/main/remote/host-service'
import { OP } from '../../src/main/remote/framing'
import type { DetachedSinks } from '../../src/main/pty-manager'
import type { PtyCreateOptions } from '../../src/shared/types'

// A fake pty-manager that records calls and lets the test fire the captured sinks.
function fakePty() {
  const calls: { method: string; args: unknown[] }[] = []
  let lastSinks: DetachedSinks | null = null
  let lastOptions: PtyCreateOptions | null = null
  let counter = 0
  const mgr: HostPtyManager = {
    createDetached(options, sinks) {
      lastOptions = options
      lastSinks = sinks
      const id = `pty-${++counter}`
      calls.push({ method: 'createDetached', args: [options, id] })
      return id
    },
    write: (sessionId, data) => calls.push({ method: 'write', args: [sessionId, data] }),
    resize: (sessionId, cols, rows) =>
      calls.push({ method: 'resize', args: [sessionId, cols, rows] }),
    setFlow: (sessionId, resume) => calls.push({ method: 'setFlow', args: [sessionId, resume] }),
    kill: (sessionId) => calls.push({ method: 'kill', args: [sessionId] })
  }
  return {
    mgr,
    calls,
    sinks: () => lastSinks!,
    options: () => lastOptions!
  }
}

function fakeSocket(sendOk = true) {
  const responses: { id: string; ok: boolean; body: unknown }[] = []
  const frames: { op: number; streamId: number; seq: number; payload: Uint8Array }[] = []
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: (op, streamId, seq, payload) => {
      frames.push({ op, streamId, seq, payload })
      return sendOk
    }
  }
  return { socket, responses, frames }
}

const resizePayload = (cols: number, rows: number) => {
  const buf = new Uint8Array(4)
  const view = new DataView(buf.buffer)
  view.setUint16(0, cols, true)
  view.setUint16(2, rows, true)
  return buf
}

describe('createHostHandlers', () => {
  it('maps pty.create to createDetached and returns a streamId', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)

    h.onRpc({ id: 'r1', method: 'pty.create', params: { cols: 100, rows: 30, cwd: '/tmp' } })

    expect(pty.options()).toMatchObject({ cols: 100, rows: 30, cwd: '/tmp' })
    expect(sock.responses).toEqual([{ id: 'r1', ok: true, body: { streamId: 1 } }])
  })

  it('pipes PTY output into OP.Output frames with an incrementing seq', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onRpc({ id: 'r1', method: 'pty.create', params: { cols: 80, rows: 24 } })

    pty.sinks().onData('hello')
    pty.sinks().onData('world')

    expect(sock.frames).toHaveLength(2)
    expect(sock.frames[0]).toMatchObject({ op: OP.Output, streamId: 1, seq: 0 })
    expect(Buffer.from(sock.frames[0].payload).toString('utf8')).toBe('hello')
    expect(sock.frames[1]).toMatchObject({ op: OP.Output, streamId: 1, seq: 1 })
  })

  it('routes OP.Input frames to write and OP.Resize frames to resize', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onRpc({ id: 'r1', method: 'pty.create', params: { cols: 80, rows: 24 } })

    h.onFrame({ op: OP.Input, streamId: 1, seq: 0, payload: new TextEncoder().encode('ls\n') })
    h.onFrame({ op: OP.Resize, streamId: 1, seq: 0, payload: resizePayload(120, 40) })

    expect(pty.calls).toContainEqual({ method: 'write', args: ['pty-1', 'ls\n'] })
    expect(pty.calls).toContainEqual({ method: 'resize', args: ['pty-1', 120, 40] })
  })

  it('ignores frames for unknown streams', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onFrame({ op: OP.Input, streamId: 99, seq: 0, payload: new TextEncoder().encode('x') })
    expect(pty.calls).toHaveLength(0)
  })

  it('pauses the PTY on backpressure and resumes on the next successful send', () => {
    const pty = fakePty()
    const sock = fakeSocket(false) // sendFrame returns false → backpressure
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onRpc({ id: 'r1', method: 'pty.create', params: { cols: 80, rows: 24 } })

    pty.sinks().onData('a') // send fails → pause
    expect(pty.calls).toContainEqual({ method: 'setFlow', args: ['pty-1', false] })

    // Flip the socket to succeed, then deliver more output → resume.
    sock.socket.sendFrame = vi.fn(() => true)
    pty.sinks().onData('b')
    expect(pty.calls).toContainEqual({ method: 'setFlow', args: ['pty-1', true] })
  })

  it('rejects unknown RPC methods', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onRpc({ id: 'r9', method: 'pty.bogus', params: {} })
    expect(sock.responses[0]).toMatchObject({ id: 'r9', ok: false })
  })

  it('pty.kill kills the session and forgets the stream', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onRpc({ id: 'r1', method: 'pty.create', params: { cols: 80, rows: 24 } })
    h.onRpc({ id: 'r2', method: 'pty.kill', params: { streamId: 1 } })

    expect(pty.calls).toContainEqual({ method: 'kill', args: ['pty-1'] })
    // After kill, input for the dropped stream is ignored.
    pty.calls.length = 0
    h.onFrame({ op: OP.Input, streamId: 1, seq: 0, payload: new TextEncoder().encode('x') })
    expect(pty.calls).toHaveLength(0)
  })

  it('emits an OP.Error frame on PTY exit and drops the stream', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onRpc({ id: 'r1', method: 'pty.create', params: { cols: 80, rows: 24 } })

    pty.sinks().onExit(0)
    const errFrame = sock.frames.find((f) => f.op === OP.Error)
    expect(errFrame).toBeDefined()
    expect(JSON.parse(Buffer.from(errFrame!.payload).toString('utf8'))).toEqual({ exitCode: 0 })
  })

  it('closeAll kills every live session', () => {
    const pty = fakePty()
    const sock = fakeSocket()
    const h = createHostHandlers(pty.mgr, sock.socket)
    h.onRpc({ id: 'r1', method: 'pty.create', params: { cols: 80, rows: 24 } })
    h.onRpc({ id: 'r2', method: 'pty.create', params: { cols: 80, rows: 24 } })
    h.closeAll()
    expect(pty.calls.filter((c) => c.method === 'kill')).toHaveLength(2)
  })
})
