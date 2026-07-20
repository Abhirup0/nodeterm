import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import {
  createPushNotify,
  createLiveUpdatePush,
  type PushNotifyDeps,
  type PushHostIdentity,
  type LiveUpdateDeps
} from './push-notify'
import {
  onInboxActionable,
  recordAgentEvent,
  initAgentStatusMirror,
  _resetForTest,
  type InboxEvent,
  type NodeStateChange,
  type NodeNowChange
} from './agent-status-mirror'

/** A generic manual event source standing in for the mirror subscribe seams. */
function emitter<T>(): { subscribe: (cb: (e: T) => void) => () => void; emit: (e: T) => void } {
  const cbs = new Set<(e: T) => void>()
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
    mobilePushNeedsYou: () => true,
    mobilePushDone: () => true,
    isPackaged: () => true,
    getNodeTitle: () => undefined,
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
        resolved: false,
        // Deterministic-approval ticket rides the mirror to the phone but MUST NOT ride the push
        // body (the phone re-reads the mirror before acting). See docs/hook-reply-approvals.md.
        pendingId: 'node-9-1789-42'
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
    expect(body.events[0]).not.toHaveProperty('pendingId')
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

  describe('per-kind selection', () => {
    it('defaults send all kinds (needsYou + done both on)', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
      em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'A' }))
      em.emit(iev({ nodeId: 'b', kind: 'question', title: 'B' }))
      em.emit(iev({ nodeId: 'c', kind: 'done', title: 'C' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events.map((e) => e.kind)).toEqual(['approval', 'question', 'done'])
      h.stop()
    })

    it('needsYou off drops approval + question but done still sends', async () => {
      const em = makeEmitter()
      const h = createPushNotify(
        baseDeps({ subscribe: em.subscribe, mobilePushNeedsYou: () => false })
      )
      em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'A' }))
      em.emit(iev({ nodeId: 'b', kind: 'question', title: 'B' }))
      em.emit(iev({ nodeId: 'c', kind: 'done', title: 'C' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(bodyOf().events.map((e) => e.kind)).toEqual(['done'])
      h.stop()
    })

    it('done off drops done but needs-you kinds still send', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe, mobilePushDone: () => false }))
      em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'A' }))
      em.emit(iev({ nodeId: 'b', kind: 'question', title: 'B' }))
      em.emit(iev({ nodeId: 'c', kind: 'done', title: 'C' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(bodyOf().events.map((e) => e.kind)).toEqual(['approval', 'question'])
      h.stop()
    })

    it('both sub-gates off sends nothing (master stays honest)', async () => {
      const em = makeEmitter()
      const h = createPushNotify(
        baseDeps({
          subscribe: em.subscribe,
          mobilePushNeedsYou: () => false,
          mobilePushDone: () => false
        })
      )
      em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'A' }))
      em.emit(iev({ nodeId: 'b', kind: 'question', title: 'B' }))
      em.emit(iev({ nodeId: 'c', kind: 'done', title: 'C' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).not.toHaveBeenCalled()
      h.stop()
    })

    it('a dropped kind does not consume the node throttle window', async () => {
      const em = makeEmitter()
      const h = createPushNotify(
        baseDeps({ subscribe: em.subscribe, mobilePushNeedsYou: () => false })
      )
      // A dropped approval on node 'a' must not throttle a following done on 'a'.
      em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'dropped' }))
      em.emit(iev({ nodeId: 'a', kind: 'done', title: 'kept' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events).toHaveLength(1)
      expect(bodyOf().events[0].title).toBe('kept')
      h.stop()
    })
  })

  describe('nodeTitle enrichment', () => {
    it('includes nodeTitle when the accessor resolves one', async () => {
      const em = makeEmitter()
      const h = createPushNotify(
        baseDeps({ subscribe: em.subscribe, getNodeTitle: (id) => (id === 'a' ? 'Backend server' : undefined) })
      )
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events[0].nodeTitle).toBe('Backend server')
      h.stop()
    })

    it('omits nodeTitle when the accessor returns undefined', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe, getNodeTitle: () => undefined }))
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events[0]).not.toHaveProperty('nodeTitle')
      h.stop()
    })

    it('omits nodeTitle when no accessor is wired at all', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe, getNodeTitle: undefined }))
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events[0]).not.toHaveProperty('nodeTitle')
      h.stop()
    })

    it('clips nodeTitle to 80 chars', async () => {
      const em = makeEmitter()
      const long = 'x'.repeat(200)
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe, getNodeTitle: () => long }))
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events[0].nodeTitle).toBe('x'.repeat(80))
      h.stop()
    })

    it('omits nodeTitle when the accessor throws (fail-open)', async () => {
      const em = makeEmitter()
      const h = createPushNotify(
        baseDeps({
          subscribe: em.subscribe,
          getNodeTitle: () => {
            throw new Error('boom')
          }
        })
      )
      em.emit(iev({ nodeId: 'a' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(bodyOf().events[0]).not.toHaveProperty('nodeTitle')
      h.stop()
    })
  })

  describe('question options pass-through', () => {
    it('passes question options into the notify payload', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
      em.emit(iev({ nodeId: 'a', kind: 'question', title: 'Pick a theme', options: ['Dark', 'Light', 'System'] }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events[0].options).toEqual(['Dark', 'Light', 'System'])
      h.stop()
    })

    it('omits options when the event has none', async () => {
      const em = makeEmitter()
      const h = createPushNotify(baseDeps({ subscribe: em.subscribe }))
      em.emit(iev({ nodeId: 'a', kind: 'approval', title: 'Approve' }))
      await vi.advanceTimersByTimeAsync(2000)
      expect(bodyOf().events[0]).not.toHaveProperty('options')
      h.stop()
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

// ---- live-update stream --------------------------------------------------------------------

describe('createLiveUpdatePush', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    clock = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function liveDeps(over: Partial<LiveUpdateDeps> = {}): LiveUpdateDeps {
    return {
      subscribeStateChange: () => () => {},
      subscribeNowChange: () => () => {},
      getHostIdentity: () => IDENTITY,
      mobilePushEnabled: () => true,
      mobileLiveActivities: () => true,
      isPackaged: () => true,
      getNodeTitle: () => undefined,
      env: {},
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => clock,
      batchWindowMs: 1000,
      coalesceMs: 20000,
      ...over
    }
  }

  function liveBodyOf(callIndex = 0): {
    hostDeviceId: string
    hostPublicKeyB64: string
    hostLabel: string
    updates: Array<Record<string, unknown>>
  } {
    return JSON.parse(fetchMock.mock.calls[callIndex][1].body)
  }

  function wire(over: Partial<LiveUpdateDeps> = {}): {
    h: ReturnType<typeof createLiveUpdatePush>
    st: ReturnType<typeof emitter<NodeStateChange>>
    nw: ReturnType<typeof emitter<NodeNowChange>>
  } {
    const st = emitter<NodeStateChange>()
    const nw = emitter<NodeNowChange>()
    const h = createLiveUpdatePush(
      liveDeps({ subscribeStateChange: st.subscribe, subscribeNowChange: nw.subscribe, ...over })
    )
    return { h, st, nw }
  }

  it('posts a state edge within the batch window (immediate)', async () => {
    const { h, st } = wire()
    st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
    expect(fetchMock).not.toHaveBeenCalled() // still batching
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.nodeterm.dev/v1/push/live-update')
    expect(init.method).toBe('POST')
    expect(liveBodyOf().updates[0]).toMatchObject({ nodeId: 'a', event: 'start', state: 'working' })
    h.stop()
  })

  it('emits the contract payload shape (host identity + trimmed update fields)', async () => {
    const { h, st } = wire({ getNodeTitle: () => 'api-server' })
    st.emit({ nodeId: 'node-1', agentId: 'claude', event: 'update', state: 'needsYou', message: 'Approve write', ts: 42 })
    await vi.advanceTimersByTimeAsync(1000)
    const body = liveBodyOf()
    expect(body.hostDeviceId).toBe('host-device-1')
    expect(body.hostPublicKeyB64).toBe('PUBKEYB64==')
    expect(body.hostLabel).toBe('niova')
    expect(body.updates[0]).toEqual({
      nodeId: 'node-1',
      nodeTitle: 'api-server',
      agentId: 'claude',
      event: 'update',
      state: 'needsYou',
      message: 'Approve write',
      ts: 42
    })
    h.stop()
  })

  it('sends a now-update immediately on the leading edge, then COALESCES ticks to ≥20s/node', async () => {
    const { h, nw } = wire()
    // Leading edge (no prior send) → sent.
    clock = 0
    nw.emit({ nodeId: 'a', activity: 'Editing a.ts', contextPercent: 10, ts: 0 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(liveBodyOf(0).updates[0]).toMatchObject({
      event: 'update',
      state: 'working',
      activity: 'Editing a.ts',
      contextPercent: 10
    })
    // A second tick 5s later is inside the 20s window → coalesced (NOT sent yet).
    clock = 5000
    nw.emit({ nodeId: 'a', activity: 'Editing b.ts', ts: 5000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // At the window edge the coalesced LATEST flushes.
    clock = 20000
    await vi.advanceTimersByTimeAsync(20000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(liveBodyOf(1).updates[0].activity).toBe('Editing b.ts')
    h.stop()
  })

  it('a state edge is NOT subject to the now-coalesce window', async () => {
    const { h, st, nw } = wire()
    clock = 0
    nw.emit({ nodeId: 'a', activity: 'x', ts: 0 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // A state edge on the same node 2s later still posts immediately (no 20s wait).
    clock = 2000
    st.emit({ nodeId: 'a', event: 'end', state: 'done', message: 'Finished', ts: 2000 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(liveBodyOf(1).updates[0]).toMatchObject({ event: 'end', state: 'done' })
    h.stop()
  })

  it('caps at 20 updates per POST and sends the remainder next', async () => {
    const { h, st } = wire()
    for (let i = 0; i < 25; i++) st.emit({ nodeId: `n${i}`, event: 'start', state: 'working', ts: i })
    await vi.advanceTimersByTimeAsync(1000)
    expect(liveBodyOf(0).updates).toHaveLength(20)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(liveBodyOf(1).updates).toHaveLength(5)
    h.stop()
  })

  it('honors NODETERM_API_BASE override', async () => {
    const { h, st } = wire({ env: { NODETERM_API_BASE: 'http://localhost:9999' } })
    st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9999/v1/push/live-update')
    h.stop()
  })

  it('drops on network error without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    const { h, st } = wire()
    st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    h.stop()
  })

  describe('inert gates (no POST)', () => {
    async function expectNoPost(over: Partial<LiveUpdateDeps>): Promise<void> {
      const { h, st, nw } = wire(over)
      st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
      nw.emit({ nodeId: 'a', activity: 'x', ts: 1 })
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchMock).not.toHaveBeenCalled()
      h.stop()
    }

    it('master switch off', async () => {
      await expectNoPost({ mobilePushEnabled: () => false })
    })
    it('live-activities sub-gate off', async () => {
      await expectNoPost({ mobileLiveActivities: () => false })
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
    it('unpackaged without a local API base', async () => {
      await expectNoPost({ isPackaged: () => false, env: {} })
    })
  })

  describe('needsYou kind/options/pendingId pass-through (interactive Dynamic Island)', () => {
    it('passes kind + pendingId on an approval needsYou edge', async () => {
      const { h, st } = wire()
      st.emit({
        nodeId: 'a',
        event: 'update',
        state: 'needsYou',
        kind: 'approval',
        message: 'Approve write',
        pendingId: 'a-123-9',
        ts: 1
      })
      await vi.advanceTimersByTimeAsync(1000)
      const u = liveBodyOf().updates[0]
      expect(u.kind).toBe('approval')
      expect(u.pendingId).toBe('a-123-9')
      expect(u).not.toHaveProperty('options')
      h.stop()
    })

    it('passes kind + options on a question needsYou edge', async () => {
      const { h, st } = wire()
      st.emit({
        nodeId: 'a',
        event: 'update',
        state: 'needsYou',
        kind: 'question',
        message: 'Pick a theme',
        options: ['Dark', 'Light', 'System'],
        ts: 1
      })
      await vi.advanceTimersByTimeAsync(1000)
      const u = liveBodyOf().updates[0]
      expect(u.kind).toBe('question')
      expect(u.options).toEqual(['Dark', 'Light', 'System'])
      expect(u).not.toHaveProperty('pendingId')
      h.stop()
    })

    it('omits kind/options/pendingId on working and done edges', async () => {
      const { h, st } = wire()
      st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
      st.emit({ nodeId: 'b', event: 'end', state: 'done', message: 'Finished', ts: 2 })
      await vi.advanceTimersByTimeAsync(1000)
      for (const u of liveBodyOf().updates) {
        expect(u).not.toHaveProperty('kind')
        expect(u).not.toHaveProperty('options')
        expect(u).not.toHaveProperty('pendingId')
      }
      h.stop()
    })

    it('now-update (activity/context) ticks never carry kind/options/pendingId', async () => {
      const { h, nw } = wire()
      clock = 0
      nw.emit({ nodeId: 'a', activity: 'Editing a.ts', contextPercent: 10, ts: 0 })
      await vi.advanceTimersByTimeAsync(1000)
      const u = liveBodyOf().updates[0]
      expect(u).not.toHaveProperty('kind')
      expect(u).not.toHaveProperty('options')
      expect(u).not.toHaveProperty('pendingId')
      h.stop()
    })
  })

  it('stop() unsubscribes both seams so later events are ignored', async () => {
    const { h, st, nw } = wire()
    h.stop()
    st.emit({ nodeId: 'a', event: 'start', state: 'working', ts: 1 })
    nw.emit({ nodeId: 'a', activity: 'x', ts: 1 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
