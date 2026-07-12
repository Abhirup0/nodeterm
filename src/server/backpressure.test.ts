import { describe, it, expect } from 'vitest'
import { ServerPlatform, type UiSink } from './platform-server'

function sink(buffered: () => number): UiSink {
  return { sendText: () => {}, sendBinary: () => {}, bufferedAmount: buffered }
}

describe('ws backpressure', () => {
  it('pauses the session when buffered crosses the high-water mark and resumes below low', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const flow: Array<{ sid: string; resume: boolean }> = []
    p.setFlowController((_uiId, sid, resume) => flow.push({ sid, resume }))
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
    p.setFlowController((_uiId, sid, resume) => flow.push({ sid, resume }))
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

  // The pause must be ATTRIBUTED to the backed-up connection: PtyManager keeps a per-client ledger
  // (Session.pausedBy) and pauses the shared pty while ANY viewer owes a resume. Sending the pause
  // without a uiId would make it unattributable — and a pause the drowning browser still owes could
  // then be cancelled by another browser's join/leave (unbounded backlog on the drowning one).
  it('attributes the pause/resume to the ui whose socket is backed up', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const flow: Array<{ uiId: number; sid: string; resume: boolean }> = []
    p.setFlowController((uiId, sid, resume) => flow.push({ uiId, sid, resume }))
    let aBuffered = 0
    const a = p.attach(sink(() => aBuffered))
    const b = p.attach(sink(() => 0)) // B keeps up

    aBuffered = 1_500_000
    p.sendTo(a, 'pty:data:s1', 'chunk')
    expect(flow).toEqual([{ uiId: a, sid: 's1', resume: false }])

    // B is keeping up, but B never paused: its send must NOT hand back the resume A owes. (With a
    // sessionId-keyed flag it would — and with the pty then paused for nobody, no data would ever
    // arrive for A to re-assert it. Attribution is what makes the pause survivable.)
    p.sendTo(b, 'pty:data:s1', 'chunk')
    expect(flow).toHaveLength(1)

    aBuffered = 0
    p.sendTo(a, 'pty:data:s1', 'chunk') // A drained → A returns its own pause
    expect(flow.at(-1)).toEqual({ uiId: a, sid: 's1', resume: true })
  })

  it('a disconnecting connection does not drop another one\'s pause flag', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const flow: Array<{ uiId: number; sid: string; resume: boolean }> = []
    p.setFlowController((uiId, sid, resume) => flow.push({ uiId, sid, resume }))
    let aBuffered = 1_500_000
    const a = p.attach(sink(() => aBuffered))
    const b = p.attach(sink(() => 0))

    p.sendTo(a, 'pty:data:s1', 'chunk') // A is behind → paused
    p.detach(b) // B closes its tab
    expect(flow).toEqual([{ uiId: a, sid: 's1', resume: false }])

    // A's flag survived B's departure, so A's drain still fires exactly one resume.
    aBuffered = 0
    p.sendTo(a, 'pty:data:s1', 'chunk')
    expect(flow).toEqual([
      { uiId: a, sid: 's1', resume: false },
      { uiId: a, sid: 's1', resume: true }
    ])
  })

  it('does no flow control when no controller is set (and non-pty channels are unaffected)', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const ui = p.attach(sink(() => 5_000_000))
    expect(() => p.sendTo(ui, 'pty:data:s1', 'x')).not.toThrow()
    expect(() => p.sendTo(ui, 'some:event', 1)).not.toThrow()
  })
})
