import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MirrorFile, MirrorSettings } from '../../core/agent-status-mirror'
import { initRemoteStatusPush } from './remote-status-push'

function doc(updatedAt: number, ids: string[]): MirrorFile {
  const nodes: MirrorFile['nodes'] = {}
  for (const id of ids) nodes[id] = { state: 'working', updatedAt }
  return { v: 1, updatedAt, nodes }
}

describe('initRemoteStatusPush', () => {
  let flushCb: ((d: MirrorFile) => void) | null
  let pushes: Array<{ id: string; json: string }>
  let disposer: { dispose: () => void } | null

  const deps = (over: Partial<Parameters<typeof initRemoteStatusPush>[0]> = {}) => ({
    onFlush: (cb: (d: MirrorFile) => void) => {
      flushCb = cb
      return () => {
        flushCb = null
      }
    },
    flush: vi.fn(async () => flushCb?.(doc(Date.now(), ['a1']))),
    sshProjectIds: () => ['p1'],
    nodeIdsFor: () => new Set(['a1']),
    push: async (id: string, json: string) => {
      pushes.push({ id, json })
    },
    heartbeatMs: 0,
    ...over
  })

  beforeEach(() => {
    vi.useFakeTimers()
    flushCb = null
    pushes = []
    disposer = null
  })

  afterEach(() => {
    disposer?.dispose()
    vi.useRealTimers()
  })

  it('pushes each project its own filtered slice on flush', () => {
    disposer = initRemoteStatusPush(
      deps({
        sshProjectIds: () => ['p1', 'p2'],
        nodeIdsFor: (id) => new Set(id === 'p1' ? ['a1'] : ['b1'])
      })
    )
    flushCb!(doc(1000, ['a1', 'b1', 'other']))
    expect(pushes).toHaveLength(2)
    const p1 = JSON.parse(pushes.find((p) => p.id === 'p1')!.json)
    expect(Object.keys(p1.nodes)).toEqual(['a1'])
    const p2 = JSON.parse(pushes.find((p) => p.id === 'p2')!.json)
    expect(Object.keys(p2.nodes)).toEqual(['b1'])
  })

  it('throttles a burst into leading + one trailing push with the LATEST doc', () => {
    disposer = initRemoteStatusPush(deps({ throttleMs: 2000 }))
    flushCb!(doc(1, ['a1']))
    flushCb!(doc(2, ['a1']))
    flushCb!(doc(3, ['a1']))
    expect(pushes).toHaveLength(1)
    expect(JSON.parse(pushes[0].json).updatedAt).toBe(1)
    vi.advanceTimersByTime(2000)
    expect(pushes).toHaveLength(2)
    expect(JSON.parse(pushes[1].json).updatedAt).toBe(3)
  })

  it('a quiet window ends the throttle without a redundant trailing push', () => {
    disposer = initRemoteStatusPush(deps({ throttleMs: 2000 }))
    flushCb!(doc(1, ['a1']))
    vi.advanceTimersByTime(2000)
    expect(pushes).toHaveLength(1)
    // Next flush after the window pushes immediately again (leading edge restored).
    flushCb!(doc(9, ['a1']))
    expect(pushes).toHaveLength(2)
  })

  it('heartbeat triggers mirror flushes on the interval', () => {
    const d = deps({ heartbeatMs: 60_000 })
    disposer = initRemoteStatusPush(d)
    expect(d.flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(d.flush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(120_000)
    expect(d.flush).toHaveBeenCalledTimes(3)
  })

  it('injects per-project settings into the pushed slice', () => {
    const settings: MirrorSettings = { claudePermissionMode: 'auto', autoSupported: true }
    disposer = initRemoteStatusPush(
      deps({
        nodeIdsFor: () => new Set(['n1']),
        settingsFor: (id: string) => ({ claudePermissionMode: 'auto', autoSupported: id === 'p1' })
      })
    )
    flushCb!({ v: 1, updatedAt: 1, nodes: { n1: { updatedAt: 1 } } })
    const slice = JSON.parse(pushes.find((p) => p.id === 'p1')!.json)
    expect(slice.settings).toEqual(settings)
    expect(Object.keys(slice.nodes)).toEqual(['n1'])
  })

  it('omits settings when settingsFor is absent or returns undefined', () => {
    disposer = initRemoteStatusPush(
      deps({
        nodeIdsFor: () => new Set(),
        settingsFor: () => undefined
      })
    )
    flushCb!({ v: 1, updatedAt: 1, nodes: {} })
    expect('settings' in JSON.parse(pushes.find((p) => p.id === 'p1')!.json)).toBe(false)
  })

  it('a throwing settingsFor never breaks the push (fails open, no settings key)', () => {
    disposer = initRemoteStatusPush(
      deps({
        nodeIdsFor: () => new Set(),
        settingsFor: () => {
          throw new Error('boom')
        }
      })
    )
    flushCb!({ v: 1, updatedAt: 1, nodes: {} })
    expect(pushes).toHaveLength(1)
    expect('settings' in JSON.parse(pushes[0].json)).toBe(false)
  })

  it('dispose unsubscribes and stops timers', () => {
    const d = deps({ heartbeatMs: 60_000, throttleMs: 2000 })
    disposer = initRemoteStatusPush(d)
    flushCb?.(doc(1, ['a1']))
    disposer.dispose()
    disposer = null
    expect(flushCb).toBeNull()
    vi.advanceTimersByTime(300_000)
    expect(d.flush).not.toHaveBeenCalled()
    expect(pushes).toHaveLength(1)
  })
})
