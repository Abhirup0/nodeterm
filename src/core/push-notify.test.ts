import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import { createPushNotify, type PushNotifyDeps, type PushHostIdentity } from './push-notify'
import {
  onInboxActionable,
  recordAgentEvent,
  initAgentStatusMirror,
  _resetForTest,
  type InboxEvent
} from './agent-status-mirror'

// ---- helpers -------------------------------------------------------------------------------

/** A manual actionable-event source standing in for `onInboxActionable`. */
function makeEmitter(): {
  subscribe: (cb: (e: InboxEvent) => void) => () => void
  emit: (e: InboxEvent) => void
} {
  const cbs = new Set<(e: InboxEvent) => void>()
  return {
    subscribe: (cb) => {
      cbs.add(cb)
      return () => cbs.delete(cb)
    },
    emit: (e) => {
      for (const cb of cbs) cb(e)
    }
  }
}

function iev(p: Partial<InboxEvent>): InboxEvent {
  return { id: 'id', ts: 1000, nodeId: 'n1', kind: 'approval', title: 'Approve write', ...p }
}

const IDENTITY: PushHostIdentity = {
  hostDeviceId: 'host-device-1',
  hostPublicKeyB64: 'PUBKEYB64==',
  hostLabel: 'niova',
  hasPairedPhone: true
}

let fetchMock: ReturnType<typeof vi.fn>
let clock: number

function baseDeps(over: Partial<PushNotifyDeps> = {}): PushNotifyDeps {
  return {
    subscribe: () => () => {},
    getHostIdentity: () => IDENTITY,
    mobilePushEnabled: () => true,
    isPackaged: () => true,
    env: {},
    fetchImpl: fetchMock as unknown as typeof fetch,
    now: () => clock,
    batchWindowMs: 2000,
    throttleMs: 5000,
    ...over
  }
}

function bodyOf(callIndex = 0): {
  hostDeviceId: string
  hostPublicKeyB64: string
  hostLabel: string
  events: Array<Record<string, unknown>>
} {
  return JSON.parse(fetchMock.mock.calls[callIndex][1].body)
}

// ---- actionable-hook seam (via the REAL mirror) --------------------------------------------

describe('onInboxActionable seam (agent-status-mirror)', () => {
  let dir: string
  beforeEach(() => {
    _resetForTest()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-hook-'))
    initAgentStatusMirror(path.join(dir, 'agent-status.json'))
  })
  afterEach(() => {
    _resetForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function ev(p: Partial<NormalizedAgentEvent>): NormalizedAgentEvent {
    return { nodeId: 'n1', agentId: 'claude', kind: 'state', ...p } as NormalizedAgentEvent
  }

  it('fires approval ONCE for a re-asserted identical prompt (dedup)', () => {
    const seen: InboxEvent[] = []
    onInboxActionable((e) => seen.push(e))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write to /etc/hosts' }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write to /etc/hosts' }))
    expect(seen.filter((e) => e.kind === 'approval')).toHaveLength(1)
    expect(seen[0].title).toBe('Approve write to /etc/hosts')
  })

  it('fires again when the ask genuinely changes', () => {
    const seen: InboxEvent[] = []
    onInboxActionable((e) => seen.push(e))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write to A' }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write to B' }))
    expect(seen.filter((e) => e.kind === 'approval')).toHaveLength(2)
  })

  it('fires done on the turn edge, once', () => {
    const seen: InboxEvent[] = []
    onInboxActionable((e) => seen.push(e))
    recordAgentEvent(ev({ nodeId: 'n2', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n2', state: 'done', lastMessage: 'All set.' }))
    recordAgentEvent(ev({ nodeId: 'n2', state: 'done' })) // no second edge
    const dones = seen.filter((e) => e.kind === 'done')
    expect(dones).toHaveLength(1)
    expect(dones[0].detail).toBe('All set.')
  })

  it('a subscriber that throws never breaks production or siblings', () => {
    const seen: InboxEvent[] = []
    onInboxActionable(() => {
      throw new Error('boom')
    })
    onInboxActionable((e) => seen.push(e))
    expect(() => recordAgentEvent(ev({ state: 'waiting', lastMessage: 'Pick one' }))).not.toThrow()
    expect(seen).toHaveLength(1)
    expect(seen[0].kind).toBe('question')
  })
})

// ---- push-notify service -------------------------------------------------------------------

describe('createPushNotify', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    clock = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('batches events landing in the window into ONE POST', async () => {
    const em = makeEmitter()
    const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
    em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'A' }))
    em.emit(iev({ nodeId: 'b', kind: 'question', title: 'B' }))
    em.emit(iev({ nodeId: 'c', kind: 'done', title: 'C' }))
    expect(fetchMock).not.toHaveBeenCalled() // still buffering
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bodyOf().events).toHaveLength(3)
    h.stop()
  })

  it('per-node throttle drops a second event for the same node inside the window', async () => {
    const em = makeEmitter()
    const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
    em.emit(iev({ nodeId: 'a', title: 'first' }))
    em.emit(iev({ nodeId: 'a', title: 'second' })) // throttled (clock unchanged)
    await vi.advanceTimersByTimeAsync(2000)
    expect(bodyOf().events).toHaveLength(1)
    expect(bodyOf().events[0].title).toBe('first')
    // After the throttle window, the node can push again.
    clock = 5000
    em.emit(iev({ nodeId: 'a', title: 'third' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodyOf(1).events[0].title).toBe('third')
    h.stop()
  })

  it('caps at 10 events per POST and sends the remainder next', async () => {
    const em = makeEmitter()
    const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
    for (let i = 0; i < 12; i++) em.emit(iev({ nodeId: `n${i}`, title: `t${i}` }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(bodyOf(0).events).toHaveLength(10)
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodyOf(1).events).toHaveLength(2)
    h.stop()
  })

  it('emits the contract payload shape (host identity + trimmed event fields)', async () => {
    const em = makeEmitter()
    const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
    em.emit(
      iev({
        nodeId: 'node-9',
        agentId: 'claude',
        kind: 'approval',
        title: 'Approve write to /etc/hosts',
        detail: 'Edit needs sudo',
        ts: 1789,
        resolved: false
      })
    )
    await vi.advanceTimersByTimeAsync(2000)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.nodeterm.dev/v1/push/notify')
    expect(init.method).toBe('POST')
    const body = bodyOf()
    expect(body.hostDeviceId).toBe('host-device-1')
    expect(body.hostPublicKeyB64).toBe('PUBKEYB64==')
    expect(body.hostLabel).toBe('niova')
    expect(body.events[0]).toEqual({
      kind: 'approval',
      title: 'Approve write to /etc/hosts',
      detail: 'Edit needs sudo',
      nodeId: 'node-9',
      agentId: 'claude',
      ts: 1789
    })
    // The internal InboxEvent fields do not leak into the payload.
    expect(body.events[0]).not.toHaveProperty('id')
    expect(body.events[0]).not.toHaveProperty('resolved')
    h.stop()
  })

  it('honors NODETERM_API_BASE override', async () => {
    const em = makeEmitter()
    const h = createPushNotify(
      baseDeps({ subscribe: em.subscribe, env: { NODETERM_API_BASE: 'http://localhost:9999' } })
    )
    em.emit(iev({ nodeId: 'a' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/v1/push/notify')
    h.stop()
  })

  it('drops on network error without throwing (no retry queue)', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    const em = makeEmitter()
    const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
    em.emit(iev({ nodeId: 'a' }))
    // The rejected fetch must not surface — flush swallows it (no retry queue).
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    h.stop()
  })

  describe('inert gates (no POST)', () => {
    async function expectNoPost(over: Partial<PushNotifyDeps>): Promise<void> {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe, ...over }))
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).not.toHaveBeenCalled()
      h.stop()
    }

    it('setting off', async () => {
      await expectNoPost({ mobilePushEnabled: () => false })
    })
    it('no relay host identity', async () => {
      await expectNoPost({ getHostIdentity: () => null })
    })
    it('no paired phone', async () => {
      await expectNoPost({ getHostIdentity: () => ({ ...IDENTITY, hasPairedPhone: false }) })
    })
    it('DO_NOT_TRACK', async () => {
      await expectNoPost({ env: { DO_NOT_TRACK: '1' } })
    })
    it('NODETERM_TELEMETRY_DISABLED', async () => {
      await expectNoPost({ env: { NODETERM_TELEMETRY_DISABLED: '1' } })
    })
    it('unpackaged without a local API base', async () => {
      await expectNoPost({ isPackaged: () => false, env: {} })
    })
  })

  it('stop() unsubscribes so later events are ignored', async () => {
    const em = makeEmitter()
    const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
    h.stop()
    em.emit(iev({ nodeId: 'a' }))
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
