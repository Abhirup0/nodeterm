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
  /**
   * Draw at most ONE frame and park again immediately, whatever the idle streak was. For repaints
   * that are known to be ISOLATED IN TIME — the blink clock, which repaints twice a second forever
   * — where `wake()` is for damage that is likely to be followed by more.
   *
   * The difference is the whole reason this member exists. `wake()` resumes the rAF chain, which
   * then costs `IDLE_FRAMES_BEFORE_PARK` frames before it parks again: thirty frames every 600 ms
   * is a loop that never parks at all, i.e. the idle canvas back at the display's refresh rate.
   * A pulse costs exactly one frame.
   *
   * A no-op while the loop is already running (that frame draws the repaint anyway) and inert
   * after `stop`.
   */
  pulse(): void
  /** Cancel everything: the pending frame, the heartbeat, and any future wake. Idempotent. */
  stop(): void
}

export function createFrameLoop(host: FrameLoopHost): FrameLoop {
  let raf = 0
  let heartbeat = 0
  let idleFrames = 0
  let stopped = false
  /** Is the frame currently scheduled a ONE-SHOT (see `pulse`)? A flag on the shared `tick` rather
   *  than a separate callback, because the two must be convertible: damage that lands between a
   *  `pulse()` and its frame has to RESUME the loop, and a dedicated one-shot callback would draw
   *  that damage and then park anyway — swallowing the wake, with the heartbeat already cancelled
   *  by it. `runLoop` therefore clears this, which is all a wake needs to do to adopt the pending
   *  frame as its own. */
  let oneShot = false

  const stop = (): void => {
    stopped = true
    if (raf) host.cancelFrame(raf)
    if (heartbeat) host.clearTimer(heartbeat)
    raf = 0
    heartbeat = 0
    oneShot = false
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
    // A frame already scheduled by a `pulse()` is ADOPTED rather than left as a one-shot: see
    // `oneShot`. Doing it here (and not in `wake`) covers the heartbeat's resume path too.
    oneShot = false
    if (!raf) raf = host.requestFrame(tick)
  }

  const tick = (): void => {
    raf = 0
    const shot = oneShot
    oneShot = false
    const { alive, drew } = drawOnce()
    if (!alive) return
    // A pulse is one frame and then parked again — deliberately regardless of `drew`, which is
    // ALWAYS true for a blink frame (the phase flip dirtied the engine). Reading that as "the
    // canvas is busy again" is exactly the loop this path exists to avoid. The idle streak and the
    // heartbeat armed at the park are both left untouched, so the loop is in the same state it was
    // in before the pulse.
    if (shot) return
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
    pulse(): void {
      // Inert after teardown, like `wake` — a blink tick racing the cleanup must not schedule a
      // frame against a context that is gone.
      if (stopped) return
      // Already running (or a pulse is already pending): that frame draws this repaint too. The
      // early return is also what keeps `oneShot` off a RUNNING loop's pending frame — setting it
      // there would turn the next ordinary tick into a park.
      if (raf) return
      oneShot = true
      raf = host.requestFrame(tick)
    },
    stop
  }
}
