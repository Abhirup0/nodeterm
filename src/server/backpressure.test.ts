import { describe, it, expect, vi } from 'vitest'
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

describe('ws drop-and-redraw ceiling (bounded memory)', () => {
  /** A sink whose buffer GROWS with every byte it is handed — a client that is not draining. */
  type Growing = { buffered: number; sends: number; resyncs: string[]; sink: UiSink }
  function growingSink(start = 0): Growing {
    const s: Growing = {
      buffered: start,
      sends: 0,
      resyncs: [] as string[],
      sink: {
        sendText: (json: string) => {
          const m = JSON.parse(json)
          if (typeof m.channel === 'string' && m.channel.startsWith('pty:resync:'))
            s.resyncs.push(String(m.args[0]))
        },
        sendBinary: (b: Uint8Array) => {
          s.sends++
          s.buffered += b.byteLength
        },
        bufferedAmount: () => s.buffered
      } as UiSink
    }
    return s
  }

  it('a client over WS_DROP_WATER stops receiving that session, the other client is untouched, and the pty is NOT paused', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const flow: Array<{ sid: string; resume: boolean }> = []
    p.setFlowController((_uiId, sid, resume) => flow.push({ sid, resume }))
    p.setResyncProvider(async () => 'SCREEN')
    const slow = growingSink(8_000_001) // already past the ceiling
    const fast = growingSink(0)
    const slowId = p.attach(slow.sink)
    const fastId = p.attach(fast.sink)

    for (let i = 0; i < 3; i++) {
      p.sendTo(slowId, 'pty:data:s1', 'chunk')
      p.sendTo(fastId, 'pty:data:s1', 'chunk')
    }
    expect(slow.sends).toBe(0) // dropped — nothing more is queued for it
    expect(slow.buffered).toBe(8_000_001) // …so its buffer stops growing (bounded)
    expect(fast.sends).toBe(3) // the fast client keeps streaming, uninterrupted
    expect(flow).toEqual([]) // and the shared pty is never paused for it
  })

  it('a client that crosses the ceiling while it OWED a pause hands that pause back', async () => {
    // The whole point of dropping: a desynced client must not hold the shared pty hostage. It
    // stopped receiving output, so it can never drain and return the pause itself — the drop is
    // where the resume is owed back, or the other viewers' terminal would freeze forever.
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const flow: Array<{ uiId: number; sid: string; resume: boolean }> = []
    p.setFlowController((uiId, sid, resume) => flow.push({ uiId, sid, resume }))
    p.setResyncProvider(async () => 'SCREEN')
    let buffered = 2_000_000 // above HIGH, below DROP
    const ui = p.attach({
      sendText: () => {},
      sendBinary: () => {},
      bufferedAmount: () => buffered
    })

    p.sendTo(ui, 'pty:data:s1', 'chunk') // over high-water → this client owes a resume
    expect(flow).toEqual([{ uiId: ui, sid: 's1', resume: false }])

    buffered = 9_000_000 // it never drained: past the ceiling
    p.sendTo(ui, 'pty:data:s1', 'chunk') // → desynced, and the pause is returned
    expect(flow).toEqual([
      { uiId: ui, sid: 's1', resume: false },
      { uiId: ui, sid: 's1', resume: true }
    ])
  })

  it('resyncs ONCE via the tmux capture path when the client drains, then resumes streaming', async () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    p.setFlowController(() => {})
    const capture = vi.fn(async () => 'CURRENT SCREEN')
    p.setResyncProvider(capture)
    const slow = growingSink(8_000_001)
    const id = p.attach(slow.sink)

    p.sendTo(id, 'pty:data:s1', 'a') // over the ceiling → desync + drop
    expect(slow.sends).toBe(0)

    slow.buffered = 1000 // the socket drained below WS_LOW_WATER
    p.sendTo(id, 'pty:data:s1', 'b') // still dropped: the redraw is in flight
    p.sendTo(id, 'pty:data:s1', 'c')
    await vi.waitFor(() => expect(slow.resyncs).toEqual(['CURRENT SCREEN']))
    expect(capture).toHaveBeenCalledTimes(1) // ONE capture — not a replay of the backlog
    expect(capture).toHaveBeenCalledWith('s1')

    slow.buffered = 1000
    p.sendTo(id, 'pty:data:s1', 'd') // resynced → normal streaming resumes
    expect(slow.sends).toBe(1)
  })

  // The ceiling is a SOCKET-wide bound, because `bufferedAmount` is `ws.bufferedAmount` — there is
  // no per-session send queue to measure. So when one session floods the socket past the ceiling,
  // EVERY session on that socket desyncs on its next chunk. That is the honest semantics (and the
  // memory bound we actually want: the socket is what holds the bytes). What IS per (client,
  // session) is the desync STATE and the redraw: each session is captured and repainted on its own.
  it('the ceiling is socket-wide: a second session on the drowning socket also desyncs — but each session gets its OWN redraw', async () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    p.setFlowController(() => {})
    const capture = vi.fn(async (sid: string) => `SCREEN ${sid}`)
    p.setResyncProvider(capture)
    const s = growingSink(8_000_001)
    const id = p.attach(s.sink)

    p.sendTo(id, 'pty:data:s1', 'x') // s1 crosses the ceiling → dropped
    p.sendTo(id, 'pty:data:s2', 'y') // s2 shares the SAME socket buffer → also dropped
    expect(s.sends).toBe(0)

    s.buffered = 1000 // the socket drained: both sessions recover, each with its own capture
    await vi.waitFor(
      () => expect([...s.resyncs].sort()).toEqual(['SCREEN s1', 'SCREEN s2']),
      { timeout: 3000 }
    )
    expect(capture.mock.calls.map((c) => c[0]).sort()).toEqual(['s1', 's2'])

    p.sendTo(id, 'pty:data:s2', 'z') // resynced → normal streaming resumes for both
    expect(s.sends).toBe(1)
  })

  // FINDING 1: the flood ENDS. The build finishes, the socket drains, and NO further pty output
  // ever arrives — so a redraw triggered by "the next chunk of that session" never happens and the
  // user stares at a truncated screen forever. The drain itself must be the trigger.
  it('resyncs a desynced client when its buffer DRAINS, even though no further output arrives', async () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    p.setFlowController(() => {})
    const capture = vi.fn(async () => 'CURRENT SCREEN')
    p.setResyncProvider(capture)
    const slow = growingSink(8_000_001)
    const id = p.attach(slow.sink)

    p.sendTo(id, 'pty:data:s1', 'a') // the flood crosses the ceiling → desync + drop
    expect(slow.sends).toBe(0)

    // Still above the low-water mark: the redraw must NOT fire yet (it would land behind an 8 MB
    // backlog and be stale on arrival).
    slow.buffered = 2_000_000
    await new Promise((r) => setTimeout(r, 400))
    expect(capture).not.toHaveBeenCalled()

    // The flood is over and the socket drained. Nothing else is ever sent on this session.
    slow.buffered = 1000
    await vi.waitFor(() => expect(slow.resyncs).toEqual(['CURRENT SCREEN']), { timeout: 3000 })
    expect(capture).toHaveBeenCalledTimes(1) // exactly one capture, not one per sweep tick
  })

  // FINDING 2: captureForResync returns '' on ANY tmux/ssh failure (ControlMaster blip, session
  // mid-respawn). The renderer's resync contract is reset() + separator + write(payload), so an
  // empty payload would WIPE a live terminal. An empty capture must never be sent.
  it('never sends a resync for an empty/failed capture — it retries instead of clearing the screen', async () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    p.setFlowController(() => {})
    const capture = vi.fn(async () => '') // tmux/ssh hiccup: every capture comes back empty
    p.setResyncProvider(capture)
    const slow = growingSink(8_000_001)
    const id = p.attach(slow.sink)

    p.sendTo(id, 'pty:data:s1', 'a') // desynced
    slow.buffered = 0 // drained → resync attempts start

    await vi.waitFor(() => expect(capture.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3000 })
    expect(slow.resyncs).toEqual([]) // NOTHING sent: an empty resync would blank a live terminal
    p.sendTo(id, 'pty:data:s1', 'b')
    expect(slow.sends).toBe(0) // still desynced (output still dropped) → the retry keeps its chance

    // The blip passes: the next capture succeeds and the client is finally repainted + streaming.
    capture.mockResolvedValue('BACK')
    await vi.waitFor(() => expect(slow.resyncs).toEqual(['BACK']), { timeout: 3000 })
    slow.buffered = 0
    p.sendTo(id, 'pty:data:s1', 'c')
    expect(slow.sends).toBe(1)
  })

  it('a throwing resync provider is contained: no unhandled rejection, the client stays desynced and recovers', async () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    p.setFlowController(() => {})
    const capture = vi.fn(async () => {
      throw new Error('tmux exploded')
    })
    p.setResyncProvider(capture as unknown as (sid: string) => Promise<string>)
    const slow = growingSink(8_000_001)
    const id = p.attach(slow.sink)

    p.sendTo(id, 'pty:data:s1', 'a')
    slow.buffered = 0
    await vi.waitFor(() => expect(capture.mock.calls.length).toBeGreaterThanOrEqual(1), { timeout: 3000 })
    expect(slow.resyncs).toEqual([])
    expect(slow.sends).toBe(0) // still desynced, not crashed
  })

  it('a dead session leaves no desync/pause state behind (pruned on pty:exit)', async () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    const flow: Array<{ sid: string; resume: boolean }> = []
    p.setFlowController((_uiId, sid, resume) => flow.push({ sid, resume }))
    const capture = vi.fn(async () => 'SCREEN')
    p.setResyncProvider(capture)
    const slow = growingSink(8_000_001)
    const id = p.attach(slow.sink)

    p.sendTo(id, 'pty:data:s1', 'a') // desynced
    p.sendTo(id, 'pty:exit:s1', 0) // the session died while the client was behind
    slow.buffered = 0
    await new Promise((r) => setTimeout(r, 500))
    expect(capture).not.toHaveBeenCalled() // nothing to capture — and no sweep is left running
    expect(slow.resyncs).toEqual([])
  })

  it('a client that leaves while desynced is not redrawn, and leaves no state behind', async () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    p.setFlowController(() => {})
    const capture = vi.fn(async () => 'SCREEN')
    p.setResyncProvider(capture)
    const slow = growingSink(8_000_001)
    const id = p.attach(slow.sink)

    p.sendTo(id, 'pty:data:s1', 'x') // desynced
    p.detach(id) // tab closed while behind
    slow.buffered = 0
    p.sendTo(id, 'pty:data:s1', 'y') // gone: no send, no capture
    await Promise.resolve()
    expect(slow.sends).toBe(0)
    expect(slow.resyncs).toEqual([])
    expect(capture).not.toHaveBeenCalled()
  })
})
