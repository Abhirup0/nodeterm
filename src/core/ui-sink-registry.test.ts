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
