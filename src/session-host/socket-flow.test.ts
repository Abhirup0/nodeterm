import { describe, expect, it, vi } from 'vitest'
import type { Socket } from 'net'
import type { HostSession } from './session'
import { drainSessionHostTransport, writeSessionHostFrame } from './socket-flow'

function fakeSession(socket?: Socket): {
  value: HostSession
  pauseTransportFor: ReturnType<typeof vi.fn>
  resumeTransportFor: ReturnType<typeof vi.fn>
} {
  const pauseTransportFor = vi.fn()
  const resumeTransportFor = vi.fn()
  return {
    value: {
      subscribers: new Set(socket ? [socket] : []),
      pauseTransportFor,
      resumeTransportFor
    } as unknown as HostSession,
    pauseTransportFor,
    resumeTransportFor
  }
}

describe('session-host socket transport flow', () => {
  it('books write(false) against every session sharing that socket and drains only those owners', () => {
    const socket = {
      write: vi.fn(() => false),
      destroy: vi.fn()
    } as unknown as Socket
    const first = fakeSession(socket)
    const second = fakeSession(socket)
    const unrelated = fakeSession()

    writeSessionHostFrame(socket, 'frame\n', [first.value, unrelated.value, second.value])
    expect(first.pauseTransportFor).toHaveBeenCalledOnce()
    expect(second.pauseTransportFor).toHaveBeenCalledOnce()
    expect(unrelated.pauseTransportFor).not.toHaveBeenCalled()

    drainSessionHostTransport(socket, [first.value, unrelated.value, second.value])
    expect(first.resumeTransportFor).toHaveBeenCalledOnce()
    expect(second.resumeTransportFor).toHaveBeenCalledOnce()
    expect(unrelated.resumeTransportFor).not.toHaveBeenCalled()
  })

  it('does not book a transport owner for a write accepted immediately', () => {
    const socket = {
      write: vi.fn(() => true),
      destroy: vi.fn()
    } as unknown as Socket
    const session = fakeSession(socket)

    writeSessionHostFrame(socket, 'frame\n', [session.value])
    expect(session.pauseTransportFor).not.toHaveBeenCalled()
  })

  it('destroys a socket whose write throws instead of trying to send a second frame', () => {
    const socket = {
      write: vi.fn(() => {
        throw new Error('socket closed during write')
      }),
      destroy: vi.fn()
    } as unknown as Socket
    const session = fakeSession(socket)

    expect(() => writeSessionHostFrame(socket, 'frame\n', [session.value])).not.toThrow()
    expect(socket.destroy).toHaveBeenCalledOnce()
    expect(socket.write).toHaveBeenCalledOnce()
    expect(session.pauseTransportFor).not.toHaveBeenCalled()
  })
})
