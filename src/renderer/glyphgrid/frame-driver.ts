/**
 * The shared canvas's frame loop, extracted from the React effect that owns it so its one
 * non-obvious behaviour — parking — is testable without a GPU, a DOM or a rendered component.
 *
 * **Why park at all.** `GlyphGridEngine.frame()` returns false when there was no damage, and an
 * idle canvas returns false forever. But while a rAF callback is registered Chromium keeps the
 * BeginFrame pipeline running: the renderer main thread, the compositor and the GPU process all
 * tick at the display's refresh rate to produce nothing. That is a floor you cannot get under, and
 * the shared renderer is meant to become the default.
 *
 * **The failure that matters is the opposite one.** A missed wake is not a slow canvas, it is a
 * FROZEN one — every shared terminal stops repainting until something incidentally dirties the
 * engine. So the design is deliberately conservative in three ways: the wake is an edge-triggered
 * subscription on the single writer of the dirty flag (`GlyphGridEngine.markDirty`), the park only
 * happens after a long idle streak, and a heartbeat re-checks while parked so a wake that was
 * somehow missed costs a second of staleness instead of the session.
 *
 * The loop owns no DOM: rAF, timers, liveness and the error policy are all injected, and the wake
 * signals (damage, window focus, visibilitychange) are wired by the host — see `SharedGlyphLayer`.
 */

/**
 * Consecutive no-damage frames before the loop parks — half a second at 60 Hz, a quarter at 120.
 *
 * Not one, and not two: a canvas goes quiet for a handful of frames between keystrokes, and
 * parking on the first idle frame would toggle the loop on and off continuously — burning the
 * park/unpark bookkeeping at input rate and putting a scheduling hop in front of every character.
 * Half a second is long enough that only a genuinely still canvas reaches it, and short enough
 * that the idle case (the one being paid for) is reached almost immediately.
 */
export const IDLE_FRAMES_BEFORE_PARK = 30

/** How often a parked loop re-checks for damage. See `beat` — this is a NET, not the mechanism. */
export const HEARTBEAT_MS = 1000

/** The park decision, pulled out so the threshold is asserted rather than assumed. */
export function shouldPark(consecutiveIdleFrames: number): boolean {
  return consecutiveIdleFrames >= IDLE_FRAMES_BEFORE_PARK
}

export interface FrameLoopHost {
  /** `GlyphGridEngine.frame()`: draws if dirty, returns whether it drew, rethrows on GL error
   *  having restored its own damage. */
  frame(): boolean
  /** False once the shared context has been torn down. Checked before every `frame()` — the
   *  context can die synchronously between a schedule and its callback. */
  alive(): boolean
  /** Terminal error policy (the layer fails the whole shared session back to the DOM renderer).
   *  The loop has already stopped itself by the time this is called. */
  onError(err: unknown): void
  requestFrame(cb: () => void): number
  cancelFrame(handle: number): void
  setTimer(cb: () => void, ms: number): number
  clearTimer(handle: number): void
}

export interface FrameLoop {
  /** Begin drawing. Idempotent. */
  start(): void
  /** "There is damage" — resume immediately if parked, otherwise just reset the idle streak.
   *  Never draws inline: it runs inside the mutator that caused the damage. Inert after `stop`. */
  wake(): void
  /** Cancel everything: the pending frame, the heartbeat, and any future wake. Idempotent. */
  stop(): void
}

export function createFrameLoop(host: FrameLoopHost): FrameLoop {
  let raf = 0
  let heartbeat = 0
  let idleFrames = 0
  let stopped = false

  const stop = (): void => {
    stopped = true
    if (raf) host.cancelFrame(raf)
    if (heartbeat) host.clearTimer(heartbeat)
    raf = 0
    heartbeat = 0
  }

  /** Everything that runs a frame shares this: liveness first, error policy second. Returns
   *  whether the loop is still alive afterwards. */
  const drawOnce = (): { alive: boolean; drew: boolean } => {
    if (!host.alive()) {
      // The context was torn down between the schedule and this callback (font change, mode
      // switched off). Stop rather than reschedule — including the heartbeat, which must never
      // outlive the context it was checking.
      stop()
      return { alive: false, drew: false }
    }
    try {
      return { alive: true, drew: host.frame() }
    } catch (err) {
      stop()
      host.onError(err)
      return { alive: false, drew: false }
    }
  }

  const park = (): void => {
    raf = 0
    heartbeat = host.setTimer(beat, HEARTBEAT_MS)
  }

  const runLoop = (): void => {
    if (heartbeat) {
      host.clearTimer(heartbeat)
      heartbeat = 0
    }
    idleFrames = 0
    if (!raf) raf = host.requestFrame(tick)
  }

  const tick = (): void => {
    raf = 0
    const { alive, drew } = drawOnce()
    if (!alive) return
    idleFrames = drew ? 0 : idleFrames + 1
    if (shouldPark(idleFrames)) park()
    else raf = host.requestFrame(tick)
  }

  /**
   * The safety NET, not the mechanism — the mechanism is the `onDamage` wake, and this exists for
   * the case where that wake never arrives (a damage path that somehow bypasses `markDirty`, a
   * listener lost to a teardown race, a pending atlas upload that is damage without being a dirty
   * flag). One no-op frame per second draws nothing when there is nothing to draw, and it turns
   * "frozen until the user drags a node" into "at most a second stale".
   */
  const beat = (): void => {
    heartbeat = 0
    const { alive, drew } = drawOnce()
    if (!alive) return
    if (drew) runLoop()
    else heartbeat = host.setTimer(beat, HEARTBEAT_MS)
  }

  return {
    start(): void {
      if (stopped || raf) return
      idleFrames = 0
      raf = host.requestFrame(tick)
    },
    wake(): void {
      // Inert after teardown: a late `onDamage` (or a focus event racing the cleanup) must not
      // resurrect a loop whose context is gone.
      if (stopped) return
      runLoop()
    },
    stop
  }
}
