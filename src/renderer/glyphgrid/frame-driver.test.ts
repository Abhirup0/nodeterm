import { describe, expect, it, vi } from 'vitest'
import {
  createFrameLoop,
  HEARTBEAT_MS,
  IDLE_FRAMES_BEFORE_PARK,
  shouldPark,
  type FrameLoopHost
} from './frame-driver'

/**
 * A hand-driven scheduler: nothing runs until the test says so, so "did the loop reschedule?" is
 * an assertion about the pending handle rather than about wall-clock time. rAF and timer handles
 * are distinct id spaces on purpose — a cancel that reached the wrong one would otherwise pass.
 */
function harness(opts: { draws?: boolean[] } = {}) {
  const draws = opts.draws ? [...opts.draws] : []
  let pendingFrame: (() => void) | null = null
  let frameHandle = 0
  let pendingTimer: { cb: () => void; ms: number } | null = null
  let timerHandle = 0
  let alive = true
  const errors: unknown[] = []
  const frame = vi.fn(() => (draws.length ? !!draws.shift() : false))

  const host: FrameLoopHost = {
    frame,
    alive: () => alive,
    onError: (err) => {
      errors.push(err)
    },
    requestFrame: (cb) => {
      pendingFrame = cb
      return ++frameHandle
    },
    cancelFrame: () => {
      pendingFrame = null
    },
    setTimer: (cb, ms) => {
      pendingTimer = { cb, ms }
      return ++timerHandle
    },
    clearTimer: () => {
      pendingTimer = null
    }
  }

  return {
    host,
    frame,
    errors,
    loop: createFrameLoop(host),
    /** Is a frame scheduled? — i.e. is the loop still running rather than parked. */
    scheduled: () => pendingFrame !== null,
    timer: () => pendingTimer,
    kill: () => {
      alive = false
    },
    /** Run the pending rAF callback (which may schedule the next one). */
    runFrame: () => {
      const cb = pendingFrame
      pendingFrame = null
      cb?.()
    },
    /** Run `n` frames, stopping early if the loop parks. */
    runFrames: (n: number) => {
      for (let i = 0; i < n; i++) {
        if (!pendingFrame) return
        const cb = pendingFrame
        pendingFrame = null
        cb()
      }
    },
    runTimer: () => {
      const t = pendingTimer
      pendingTimer = null
      t?.cb()
    },
    setDraws: (next: boolean[]) => {
      draws.length = 0
      draws.push(...next)
    }
  }
}

describe('shouldPark', () => {
  it('never parks on the first idle frame — a two-frame gap between keystrokes must not thrash', () => {
    expect(shouldPark(0)).toBe(false)
    expect(shouldPark(1)).toBe(false)
    expect(shouldPark(IDLE_FRAMES_BEFORE_PARK - 1)).toBe(false)
  })

  it('parks once the streak reaches the threshold', () => {
    expect(shouldPark(IDLE_FRAMES_BEFORE_PARK)).toBe(true)
    expect(shouldPark(IDLE_FRAMES_BEFORE_PARK + 10)).toBe(true)
  })

  it('the threshold is about half a second of frames, not a couple', () => {
    expect(IDLE_FRAMES_BEFORE_PARK).toBeGreaterThanOrEqual(20)
  })
})

describe('createFrameLoop', () => {
  it('keeps rescheduling while frames draw', () => {
    const h = harness({ draws: Array(50).fill(true) })
    h.loop.start()
    h.runFrames(50)
    expect(h.frame).toHaveBeenCalledTimes(50)
    expect(h.scheduled()).toBe(true)
  })

  it('parks after the idle threshold and not before, and arms the heartbeat when it does', () => {
    const h = harness()
    h.loop.start()
    h.runFrames(IDLE_FRAMES_BEFORE_PARK - 1)
    expect(h.scheduled()).toBe(true) // still running — an idle blip is not a park
    expect(h.timer()).toBeNull()
    h.runFrame() // the frame that completes the streak
    expect(h.scheduled()).toBe(false) // parked: no rAF registered, so Chromium can idle
    expect(h.timer()?.ms).toBe(HEARTBEAT_MS)
  })

  it('a drawn frame resets the idle streak', () => {
    const h = harness()
    h.loop.start()
    h.runFrames(IDLE_FRAMES_BEFORE_PARK - 1)
    h.setDraws([true])
    h.runFrame() // drew → streak back to zero
    h.runFrames(IDLE_FRAMES_BEFORE_PARK - 1)
    expect(h.scheduled()).toBe(true)
  })

  it('wake() un-parks: it cancels the heartbeat and resumes the rAF loop', () => {
    const h = harness()
    h.loop.start()
    h.runFrames(IDLE_FRAMES_BEFORE_PARK)
    expect(h.scheduled()).toBe(false)
    h.loop.wake()
    expect(h.timer()).toBeNull()
    expect(h.scheduled()).toBe(true)
    h.setDraws([true])
    h.runFrame()
    expect(h.frame).toHaveBeenCalledTimes(IDLE_FRAMES_BEFORE_PARK + 1)
  })

  it('a wake while already running neither double-schedules nor draws synchronously', () => {
    const h = harness({ draws: [true] })
    h.loop.start()
    const before = h.frame.mock.calls.length
    h.loop.wake()
    h.loop.wake()
    expect(h.frame).toHaveBeenCalledTimes(before) // wake SCHEDULES, it never draws inline
    h.runFrame()
    expect(h.scheduled()).toBe(true)
    h.runFrame() // the single pending callback — a double schedule would show as an extra frame
    expect(h.frame).toHaveBeenCalledTimes(before + 2)
  })

  it('a wake right before the park frame keeps the loop running', () => {
    const h = harness()
    h.loop.start()
    h.runFrames(IDLE_FRAMES_BEFORE_PARK - 1)
    h.loop.wake() // damage arrived: the streak must not carry over into a park
    h.runFrame()
    expect(h.scheduled()).toBe(true)
  })

  it('the parked heartbeat draws one frame and re-arms itself when nothing changed', () => {
    const h = harness()
    h.loop.start()
    h.runFrames(IDLE_FRAMES_BEFORE_PARK)
    const parkedAt = h.frame.mock.calls.length
    h.runTimer()
    expect(h.frame).toHaveBeenCalledTimes(parkedAt + 1) // exactly one no-op frame per second
    expect(h.scheduled()).toBe(false) // nothing drew → still parked
    expect(h.timer()?.ms).toBe(HEARTBEAT_MS) // …and the net stays armed
  })

  it('the heartbeat resumes the loop when it DOES draw — the missed-wake safety net', () => {
    const h = harness()
    h.loop.start()
    h.runFrames(IDLE_FRAMES_BEFORE_PARK)
    h.setDraws([true])
    h.runTimer()
    expect(h.scheduled()).toBe(true) // back on rAF
    expect(h.timer()).toBeNull() // and the heartbeat stood down
  })

  it('stop() clears the rAF and the heartbeat, and wake() afterwards is inert', () => {
    const h = harness()
    h.loop.start()
    h.runFrames(IDLE_FRAMES_BEFORE_PARK) // park → heartbeat armed
    h.loop.stop()
    expect(h.timer()).toBeNull()
    expect(h.scheduled()).toBe(false)
    const after = h.frame.mock.calls.length
    h.loop.wake()
    expect(h.scheduled()).toBe(false) // a late onDamage must not resurrect a torn-down loop
    expect(h.frame).toHaveBeenCalledTimes(after)
  })

  it('stop() while running cancels the pending frame', () => {
    const h = harness({ draws: Array(10).fill(true) })
    h.loop.start()
    h.runFrame()
    h.loop.stop()
    expect(h.scheduled()).toBe(false)
  })

  it('a dead host stops the loop instead of rescheduling — no timer outlives the context', () => {
    const h = harness({ draws: Array(10).fill(true) })
    h.loop.start()
    h.kill()
    h.runFrame()
    expect(h.frame).not.toHaveBeenCalled() // the disposal is checked BEFORE touching the engine
    expect(h.scheduled()).toBe(false)
    expect(h.timer()).toBeNull()
  })

  it('a dead host stops the loop from the heartbeat too', () => {
    const h = harness()
    h.loop.start()
    h.runFrames(IDLE_FRAMES_BEFORE_PARK)
    h.kill()
    h.runTimer()
    expect(h.scheduled()).toBe(false)
    expect(h.timer()).toBeNull()
  })

  it('a throwing frame reports the error once and leaves nothing scheduled', () => {
    const boom = new Error('context lost')
    const h = harness()
    h.host.frame = () => {
      throw boom
    }
    h.loop.start()
    h.runFrame()
    expect(h.errors).toEqual([boom])
    expect(h.scheduled()).toBe(false)
    expect(h.timer()).toBeNull()
  })

  it('a throwing heartbeat frame reports and tears down as well', () => {
    const boom = new Error('context lost')
    const h = harness()
    h.loop.start()
    h.runFrames(IDLE_FRAMES_BEFORE_PARK)
    h.host.frame = () => {
      throw boom
    }
    h.runTimer()
    expect(h.errors).toEqual([boom])
    expect(h.scheduled()).toBe(false)
    expect(h.timer()).toBeNull()
  })
})
