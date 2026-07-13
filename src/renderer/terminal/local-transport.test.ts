import { describe, it, expect, vi } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import { LocalTransport } from './local-transport'

describe('LocalTransport injected api', () => {
  it('delegates to the injected api, not the global', () => {
    const create = vi.fn(async () => ({ sessionId: 's', fresh: true }) as never)
    const api = {
      pty: {
        create,
        write: vi.fn(),
        resize: vi.fn(),
        setFlow: vi.fn(),
        kill: vi.fn(),
        destroy: vi.fn(),
        recycle: vi.fn(),
        onData: vi.fn(),
        onExit: vi.fn(),
        onSize: vi.fn(),
        onClosed: vi.fn(),
        onRecycled: vi.fn(),
        onResync: vi.fn()
      }
    } as unknown as NodeTerminalApi
    const t = new LocalTransport(api)
    void t.create({ persistKey: 'k' } as never)
    expect(create).toHaveBeenCalledWith({ persistKey: 'k' })
  })
})

describe('LocalTransport co-attach members', () => {
  it('subscribes to the authoritative size, the closed-by-peer event and the redraw', () => {
    const unsubSize = vi.fn()
    const unsubClosed = vi.fn()
    const unsubResync = vi.fn()
    const onSize = vi.fn(() => unsubSize)
    const onClosed = vi.fn(() => unsubClosed)
    const onResync = vi.fn(() => unsubResync)
    // @ts-expect-error — minimal window shim for the three members under test
    globalThis.window = { nodeTerminal: { pty: { onSize, onClosed, onResync } } }
    const t = new LocalTransport()
    const sizeCb = (): void => {}
    const closedCb = (): void => {}
    const resyncCb = (): void => {}
    const offSize = t.onSize?.('pty-1', sizeCb)
    const offClosed = t.onClosed?.('pty-1', closedCb)
    const offResync = t.onResync?.('pty-1', resyncCb)
    expect(onSize).toHaveBeenCalledWith('pty-1', sizeCb)
    expect(onClosed).toHaveBeenCalledWith('pty-1', closedCb)
    expect(onResync).toHaveBeenCalledWith('pty-1', resyncCb)

    // Every subscription must hand back a working unsubscribe: a terminal node mounts and
    // unmounts constantly (project switches), so a dropped unsubscribe is a leak per mount.
    offSize?.()
    offClosed?.()
    offResync?.()
    expect(unsubSize).toHaveBeenCalledTimes(1)
    expect(unsubClosed).toHaveBeenCalledTimes(1)
    expect(unsubResync).toHaveBeenCalledTimes(1)
  })
})
