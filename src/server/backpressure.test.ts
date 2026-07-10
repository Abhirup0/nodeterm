import { describe, it, expect } from 'vitest'
import { ServerPlatform, type UiSink } from './platform-server'

function sink(buffered: () => number): UiSink {
  return { sendText: () => {}, sendBinary: () => {}, bufferedAmount: buffered }
}

describe('ws backpressure', () => {
  it('pauses the session when buffered crosses the high-water mark and resumes below low', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const flow: Array<{ sid: string; resume: boolean }> = []
    p.setFlowController((sid, resume) => flow.push({ sid, resume }))
    let buffered = 0
    const ui = p.attach(sink(() => buffered))

    buffered = 500_000
    p.sendTo(ui, 'pty:data:s1', 'chunk') // under high-water → no pause
    expect(flow).toEqual([])

    buffered = 1_500_000
    p.sendTo(ui, 'pty:data:s1', 'chunk') // over high-water → pause once
    expect(flow).toEqual([{ sid: 's1', resume: false }])

    buffered = 1_400_000
    p.sendTo(ui, 'pty:data:s1', 'chunk') // still high, already paused → no repeat
    expect(flow).toEqual([{ sid: 's1', resume: false }])

    buffered = 100_000
    p.sendTo(ui, 'pty:data:s1', 'chunk') // below low-water → resume once
    expect(flow).toEqual([{ sid: 's1', resume: false }, { sid: 's1', resume: true }])
  })

  it('does no flow control when no controller is set (and non-pty channels are unaffected)', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const ui = p.attach(sink(() => 5_000_000))
    expect(() => p.sendTo(ui, 'pty:data:s1', 'x')).not.toThrow()
    expect(() => p.sendTo(ui, 'some:event', 1)).not.toThrow()
  })
})
