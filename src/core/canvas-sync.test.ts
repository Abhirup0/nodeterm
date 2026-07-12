import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initPlatform, resetPlatformForTests, type CorePlatform } from './platform'
import { fakePlatform } from './platform-fake'
import { initCanvasSync, reflectTargets, isCanvasMutation, MUTATION_MAX_BYTES } from './canvas-sync'
import { IPC } from '../shared/ipc'
import type { CanvasMutation, CanvasNodeState } from '../shared/types'

const node = (id: string, x = 0): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    title: 't',
    color: '#fff',
    position: { x, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNodeState

/** Recording CorePlatform with a cast() that carries the sender id (the Stage-1 onWithSender seam). */
function testPlatform() {
  const sent: Array<{ to: number; channel: string; args: unknown[] }> = []
  const registrations: string[] = []
  let clients: number[] = []
  const senderListeners = new Map<string, (senderId: number, ...args: any[]) => void>()
  const p: CorePlatform = {
    userDataDir: '/tmp/nodeterm-canvas-sync-test',
    appVersion: '0.0.0-test',
    isPackaged: false,
    handle: () => {},
    on: () => {},
    handleWithSender: () => {},
    onWithSender: (ch, fn) => {
      registrations.push(ch)
      senderListeners.set(ch, fn)
    },
    clientIds: () => clients,
    sendTo: (to, channel, ...args) => void sent.push({ to, channel, args }),
    broadcast: () => {},
    openExternal: async () => {}
  }
  return {
    p,
    sent,
    registrations,
    setClients: (ids: number[]) => (clients = ids),
    cast: (senderId: number, ...args: unknown[]) =>
      senderListeners.get(IPC.canvasMut)?.(senderId, ...args)
  }
}

let t: ReturnType<typeof testPlatform>

beforeEach(() => {
  t = testPlatform()
  initPlatform(t.p)
  initCanvasSync()
})
afterEach(() => resetPlatformForTests())

describe('reflectTargets', () => {
  it('is every attached client except the sender', () => {
    expect(reflectTargets([1, 2, 3], 2)).toEqual([1, 3])
    expect(reflectTargets([1], 1)).toEqual([])
    expect(reflectTargets([], 1)).toEqual([])
  })
})

describe('isCanvasMutation', () => {
  it('accepts well-formed mutations and rejects malformed ones', () => {
    expect(isCanvasMutation({ op: 'remove', id: 'n1' })).toBe(true)
    expect(isCanvasMutation({ op: 'upsert', node: node('n1') })).toBe(true)
    expect(isCanvasMutation({ op: 'upsert' })).toBe(false)
    expect(isCanvasMutation({ op: 'upsert', node: { position: { x: 1, y: 1 } } })).toBe(false)
    expect(isCanvasMutation({ op: 'remove' })).toBe(false)
    expect(isCanvasMutation({ op: 'nope', id: 'n1' })).toBe(false)
    expect(isCanvasMutation(null)).toBe(false)
    expect(isCanvasMutation('n1')).toBe(false)
  })

  it('rejects a non-finite position (NaN/Infinity would wedge React Flow)', () => {
    expect(isCanvasMutation({ op: 'upsert', node: { ...node('n1'), position: { x: NaN, y: 0 } } })).toBe(false)
    expect(
      isCanvasMutation({ op: 'upsert', node: { ...node('n1'), position: { x: 0, y: Infinity } } })
    ).toBe(false)
  })

  it('bounds what comes off the wire: over-long ids and oversized nodes are rejected', () => {
    expect(isCanvasMutation({ op: 'remove', id: 'x'.repeat(129) })).toBe(false)
    expect(isCanvasMutation({ op: 'upsert', node: { ...node('x'.repeat(129)) } })).toBe(false)
    const fat = { ...node('n1'), data: { text: 'a'.repeat(MUTATION_MAX_BYTES) } }
    expect(isCanvasMutation({ op: 'upsert', node: fat })).toBe(false)
  })
})

describe('initCanvasSync (reflector)', () => {
  it('echo suppression: the sender never receives its own mutation', () => {
    t.setClients([1, 2, 3])
    const m: CanvasMutation = { op: 'upsert', node: node('n1', 42) }
    t.cast(2, 'p1', m)
    expect(t.sent).toEqual([
      { to: 1, channel: IPC.canvasMut, args: ['p1', m] },
      { to: 3, channel: IPC.canvasMut, args: ['p1', m] }
    ])
  })

  it('sends nothing when the sender is the only attached client', () => {
    t.setClients([1])
    t.cast(1, 'p1', { op: 'remove', id: 'n1' })
    expect(t.sent).toEqual([])
  })

  it('drops a malformed mutation instead of reflecting it', () => {
    t.setClients([1, 2])
    t.cast(1, 'p1', { op: 'upsert' })
    t.cast(1, 'p1', undefined)
    t.cast(1, undefined, { op: 'remove', id: 'n1' })
    t.cast(1, 'p'.repeat(129), { op: 'remove', id: 'n1' })
    expect(t.sent).toEqual([])
  })

  it('holds no canvas state: it reflects each mutation verbatim, in order', () => {
    t.setClients([1, 2])
    t.cast(1, 'p1', { op: 'upsert', node: node('a') })
    t.cast(2, 'p1', { op: 'remove', id: 'a' })
    expect(t.sent).toEqual([
      { to: 2, channel: IPC.canvasMut, args: ['p1', { op: 'upsert', node: node('a') }] },
      { to: 1, channel: IPC.canvasMut, args: ['p1', { op: 'remove', id: 'a' }] }
    ])
  })

  it('is NOT rate-limited: a bulk delete of many nodes reflects every one', () => {
    t.setClients([1, 2])
    for (let i = 0; i < 200; i++) t.cast(1, 'p1', { op: 'remove', id: `n${i}` })
    expect(t.sent).toHaveLength(200)
    expect(t.sent[199]).toEqual({ to: 2, channel: IPC.canvasMut, args: ['p1', { op: 'remove', id: 'n199' }] })
  })

  // `on` and `onWithSender` COMPOSE on the same channel — on BOTH shells (see
  // pty-manager-platform.test.ts). A second, plain listener on canvas:mut would reflect every
  // mutation TWICE to every peer. Registration must be sender-aware and singular.
  it('registers canvas:mut EXACTLY ONCE, sender-aware (no composed plain listener)', () => {
    resetPlatformForTests()
    const fake = fakePlatform()
    initPlatform(fake)
    initCanvasSync()
    expect(fake.senderListeners[IPC.canvasMut]).toBeDefined()
    expect(fake.listeners[IPC.canvasMut]).toBeUndefined()
    expect(fake.handlers[IPC.canvasMut]).toBeUndefined()
  })

  // ServerPlatform keeps an ORDERED SET of listeners per channel, so a second registration on the
  // same platform is not an overwrite — it would reflect every mutation twice to every peer.
  it('is idempotent per platform: initCanvasSync twice registers the listener once', () => {
    expect(t.registrations).toEqual([IPC.canvasMut]) // beforeEach registered it
    initCanvasSync()
    expect(t.registrations).toEqual([IPC.canvasMut])
  })
})
