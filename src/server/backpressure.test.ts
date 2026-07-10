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
    p.sendTo(ui, 'pty:data:s1', 'chunk') // still above high-water → re-asserts pause (idempotent)
    expect(flow).toEqual([{ sid: 's1', resume: false }, { sid: 's1', resume: false }])

    buffered = 100_000
    p.sendTo(ui, 'pty:data:s1', 'chunk') // below low-water → resume once (resume side stays edge-guarded)
    expect(flow).toEqual([
      { sid: 's1', resume: false },
      { sid: 's1', resume: false },
      { sid: 's1', resume: true }
    ])
  })

  it('re-asserts pause on every high send so a renderer-side resume cannot latch it off', () => {
    // The renderer's own xterm flow control drives the SAME ptyManager.setFlow actuator.
    // If it resumes the pty underneath us while the socket buffer is still full, the
    // server must be able to re-pause — an edge-latched guard would silently latch OFF.
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const flow: Array<{ sid: string; resume: boolean }> = []
    p.setFlowController((sid, resume) => flow.push({ sid, resume }))
    const ui = p.attach(sink(() => 1_500_000)) // stays above high-water

    p.sendTo(ui, 'pty:data:s1', 'chunk') // pause (rising edge)
    expect(flow).toEqual([{ sid: 's1', resume: false }])

    // Simulate the renderer resuming the pty underneath us (bypassing the server's Map):
    // data floods again → a subsequent high send must RE-FIRE the pause, not skip it.
    p.sendTo(ui, 'pty:data:s1', 'chunk')
    p.sendTo(ui, 'pty:data:s1', 'chunk')
    expect(flow).toEqual([
      { sid: 's1', resume: false },
      { sid: 's1', resume: false },
      { sid: 's1', resume: false }
    ])
  })

  it('does no flow control when no controller is set (and non-pty channels are unaffected)', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const ui = p.attach(sink(() => 5_000_000))
    expect(() => p.sendTo(ui, 'pty:data:s1', 'x')).not.toThrow()
    expect(() => p.sendTo(ui, 'some:event', 1)).not.toThrow()
  })
})
