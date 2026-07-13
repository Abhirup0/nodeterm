import { describe, it, expect, vi } from 'vitest'
import { UiSinkRegistry, type UiSink } from './ui-sink-registry'
import { decodePtyData } from '../shared/rpc'

function sink(buffered = () => 0) {
  const texts: string[] = []
  const bins: Uint8Array[] = []
  return {
    texts,
    bins,
    ui: {
      sendText: (j: string) => texts.push(j),
      sendBinary: (b) => bins.push(b),
      bufferedAmount: buffered
    } as UiSink
  }
}

describe('UiSinkRegistry', () => {
  it('register/ids/has/unregister track the sink set in insertion order', () => {
    const r = new UiSinkRegistry()
    const a = sink()
    const b = sink()
    r.register(1_000_000, a.ui)
    r.register(1_000_001, b.ui)
    expect(r.ids()).toEqual([1_000_000, 1_000_001])
    expect(r.has(1_000_000)).toBe(true)
    r.unregister(1_000_000)
    expect(r.ids()).toEqual([1_000_001])
    expect(r.has(1_000_000)).toBe(false)
  })

  it('a non-pty channel is a JSON ev frame; pty:data is a binary frame', () => {
    const r = new UiSinkRegistry()
    const s = sink()
    r.register(7, s.ui)
    r.sendTo(7, 'presence:sync', [{ clientId: 7 }])
    expect(JSON.parse(s.texts[0])).toEqual({
      t: 'ev',
      channel: 'presence:sync',
      args: [[{ clientId: 7 }]]
    })
    r.sendTo(7, 'pty:data:s1', 'hello')
    expect(decodePtyData(s.bins[0])).toEqual({ sessionId: 's1', data: 'hello' })
  })

  it('pauses on the socket owner over high-water and hands the pause back over the DROP ceiling', () => {
    const r = new UiSinkRegistry()
    const flow: Array<{ resume: boolean; owner: string }> = []
    r.setFlowController((_id, _sid, resume, owner) => flow.push({ resume, owner }))
    r.setResyncProvider(async () => 'SCREEN')
    let buffered = 1_500_000
    r.register(9, { sendText: () => {}, sendBinary: () => {}, bufferedAmount: () => buffered })
    r.sendTo(9, 'pty:data:s1', 'x') // over high-water → pause
    buffered = 9_000_000
    r.sendTo(9, 'pty:data:s1', 'x') // over WS_DROP_WATER → desync, pause returned
    expect(flow).toEqual([
      { resume: false, owner: 'socket' },
      { resume: true, owner: 'socket' }
    ])
  })

  it('unregister prunes flow/desync state and never touches another id', () => {
    const r = new UiSinkRegistry()
    r.setFlowController(() => {})
    r.register(9, { sendText: () => {}, sendBinary: () => {}, bufferedAmount: () => 1_500_000 })
    r.register(10, { sendText: () => {}, sendBinary: () => {}, bufferedAmount: () => 0 })
    r.sendTo(9, 'pty:data:s1', 'x') // 9 is paused
    r.unregister(9)
    expect(r.has(9)).toBe(false)
    expect(r.has(10)).toBe(true)
    expect(() => r.sendTo(9, 'pty:data:s1', 'y')).not.toThrow() // gone → silent no-op
  })
})

/**
 * A sink that THROWS is a dead connection, and one dead connection must never take the fan-out
 * (or the emitter behind it — presenceHub.emit / the canvas reflector) down with it: with the sends
 * unisolated, peer B's half-closed relay socket would stop peer C from ever seeing the presence
 * diff, and blow up the HOST's own emit.
 */
describe('UiSinkRegistry — a throwing sink is contained', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  it('a sink whose sendText throws neither unwinds nor starves the other sinks', () => {
    const r = new UiSinkRegistry()
    const good = sink()
    r.register(1, { sendText: () => { throw new Error('EPIPE') }, sendBinary: () => {} })
    r.register(2, good.ui)
    // The fan-out every broadcast does (ServerPlatform.broadcast / electronPlatform.broadcast).
    expect(() => {
      for (const id of r.ids()) r.sendTo(id, 'presence:peer', { op: 'join' })
    }).not.toThrow()
    expect(JSON.parse(good.texts[0]!)).toEqual({
      t: 'ev',
      channel: 'presence:peer',
      args: [{ op: 'join' }]
    })
    expect(warn).toHaveBeenCalled() // never silent
  })

  it('a sink whose sendBinary throws neither unwinds nor starves the other sinks', () => {
    const r = new UiSinkRegistry()
    const good = sink()
    r.register(1, { sendText: () => {}, sendBinary: () => { throw new Error('EPIPE') } })
    r.register(2, good.ui)
    expect(() => {
      for (const id of r.ids()) r.sendTo(id, 'pty:data:s1', 'hello')
    }).not.toThrow()
    expect(decodePtyData(good.bins[0]!)).toEqual({ sessionId: 's1', data: 'hello' })
  })

  it('a sink that keeps throwing is treated as GONE: evicted, handler run, iteration safe', () => {
    const r = new UiSinkRegistry()
    const goneIds: number[] = []
    r.setSinkGoneHandler((id) => goneIds.push(id))
    const good = sink()
    r.register(1, { sendText: () => { throw new Error('EPIPE') }, sendBinary: () => {} })
    r.register(2, good.ui)
    // Two fan-outs over the SAME ids() snapshot: the eviction happens mid-iteration (the dead sink
    // is dropped from the Map while the loop is still walking it), and the healthy sink behind it
    // must still be served on both passes.
    for (let i = 0; i < 2; i++) for (const id of r.ids()) r.sendTo(id, 'presence:peer', { i })
    expect(goneIds).toEqual([1]) // exactly once, the dead one
    expect(r.has(1)).toBe(false)
    expect(r.has(2)).toBe(true)
    expect(good.texts).toHaveLength(2)
    // Gone means gone: no further send is even attempted at it (and it cannot be evicted twice).
    r.sendTo(1, 'presence:peer', { i: 9 })
    expect(goneIds).toEqual([1])
  })

  it('a TRANSIENT throw never evicts a healthy sink', () => {
    const r = new UiSinkRegistry()
    const goneIds: number[] = []
    r.setSinkGoneHandler((id) => goneIds.push(id))
    let blip = true
    const texts: string[] = []
    r.register(1, {
      sendText: (j) => {
        if (blip) {
          blip = false
          throw new Error('transient')
        }
        texts.push(j)
      },
      sendBinary: () => {}
    })
    r.sendTo(1, 'presence:peer', { n: 1 }) // throws once…
    r.sendTo(1, 'presence:peer', { n: 2 }) // …and the sink recovers: the strike is reset
    r.sendTo(1, 'presence:peer', { n: 3 })
    r.sendTo(1, 'presence:peer', { n: 4 })
    expect(goneIds).toEqual([])
    expect(r.has(1)).toBe(true)
    expect(texts).toHaveLength(3)
  })

  it('with no gone-handler wired, a dead sink still evicts itself (no state left behind)', () => {
    vi.useFakeTimers()
    try {
      const r = new UiSinkRegistry()
      r.setFlowController(() => {})
      r.register(9, {
        sendText: () => { throw new Error('EPIPE') },
        sendBinary: () => {},
        bufferedAmount: () => 1_500_000
      })
      r.sendTo(9, 'pty:data:s1', 'x') // jammed socket → pause booked, drain sweep armed
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      r.sendTo(9, 'presence:peer', {})
      r.sendTo(9, 'presence:peer', {}) // second consecutive throw → gone
      expect(r.has(9)).toBe(false)
      expect(vi.getTimerCount()).toBe(0) // …and no sweep timer outlives it
    } finally {
      vi.useRealTimers()
    }
  })
})
