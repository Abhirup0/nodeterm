/**
 * Trackpad gesture ledger — the main-process half of canvas wheel routing.
 *
 * The renderer cannot tell a precise-pixel mouse (Magic Mouse, MX Master) from a trackpad: both
 * reach the DOM as unmodified pixel-mode wheel events, which is why `canvas/wheel-gesture.ts`
 * historically guessed from delta shapes and offered `trackpadPan` off as the escape hatch. The
 * main process CAN tell: macOS delivers a trackpad's two-finger scroll to `webContents`
 * 'input-event' wrapped in `gestureScrollBegin`/`gestureScrollEnd` (momentum included, as its own
 * begin/end pair) and a pinch in `gesturePinchBegin`/`gesturePinchEnd`, while a wheel mouse only
 * ever produces bare `mouseWheel` packets — measured on Electron 42 / macOS with an MX Master 3S
 * and a MacBook trackpad side by side.
 *
 * This ledger reduces that stream to edge transitions ("a trackpad gesture is now open / now
 * closed") so the wire cost is a handful of IPC messages per physical gesture, not one per
 * packet. Depth-counting keeps an inner pinch inside an open scroll phase from reporting a false
 * close, and a stray end (whose begin predates the listener) is ignored rather than driving the
 * depth negative.
 *
 * Timing note for the consumer: one `mouseWheel` precedes the touch phase's `gestureScrollBegin`,
 * and a few more sit in the gap before the momentum phase's begin. The renderer's router absorbs
 * both with the same linger window it already used for heuristic stickiness — see
 * `MacWheelGestureRouter.noteGesture`.
 *
 * Self-healing (issue #535). A pure depth counter is only correct while every Begin is eventually
 * paired with an End. If macOS ever drops the End for an open gesture — ⌘Tab / hide / minimize
 * mid-scroll, a display sleep or GPU reset — the depth sticks at ≥ 1 for the life of the window:
 * every later gesture then nests inside the phantom one, so NO edge transition is ever emitted
 * again, the renderer holds `gestureActive = true` forever, and wheel zoom is silently dead until
 * the app restarts. A stray End cannot rescue it either (strays are only observed at depth 0).
 * Two guards close that, both cheap and both refusals rather than guesses:
 *
 *  1. `reset()` — the shell calls it on window blur (see main/index.ts). A trackpad gesture cannot
 *     meaningfully span a focus loss, so this can never misclassify anything the user still cares
 *     about; the worst case after a blur is the already-documented touch→momentum-gap linger.
 *  2. A staleness check at BEGIN — a real open gesture interleaves gesture packets continuously,
 *     so depth > 0 with no gesture packet for `GESTURE_STALE_MS` is a phantom and is cleared
 *     before the new Begin is counted. This is what heals a drop that came with no blur at all
 *     (display sleep), on the user's very next trackpad gesture.
 *
 * Deliberately NOT done: healing on a bare `mouseWheel` packet. It would fix the reported symptom
 * one gesture sooner, but a wheel packet is also what a REAL trackpad scroll is made of, so a
 * mis-timed heal would report a close in the middle of a live pan — and the renderer answers a
 * close by zooming. A wrong zoom mid-pan is worse than one extra gesture of latency, and which
 * gesture packets macOS interleaves during a slow scroll has not been measured.
 */

const GESTURE_BEGIN = new Set(['gestureScrollBegin', 'gesturePinchBegin'])
const GESTURE_END = new Set(['gestureScrollEnd', 'gesturePinchEnd'])

/** Every Chromium input-event type that belongs to a trackpad gesture shares this prefix
 *  (`gestureScrollUpdate`, `gesturePinchUpdate`, `gestureFlingStart`, …). Matching the family by
 *  prefix rather than by an explicit list keeps the staleness clock fed by whatever packets the
 *  running Chromium actually interleaves — an under-listed set would make a live gesture look
 *  stale, which is the one direction that misbehaves. */
const GESTURE_PREFIX = 'gesture'

/**
 * How long an open gesture may go with no gesture packet at all before the NEXT Begin treats it as
 * a phantom left by a dropped End. Real gestures interleave packets at ~120 Hz, so two seconds is
 * three orders of magnitude of headroom; the cost of being wrong in the other direction is only
 * that the heal waits for one more gesture.
 */
export const GESTURE_STALE_MS = 2000

export class TrackpadGestureLedger {
  private depth = 0
  /** When a gesture packet of any kind was last seen. Only read while `depth > 0`. */
  private lastGestureAt = 0

  /** Feed one raw input-event type; returns the new active state on a transition, null when
   *  nothing changed (the overwhelmingly common case — this runs on every input event). `now` is
   *  injected so the staleness guard stays deterministically testable. */
  observe(type: string, now: number = Date.now()): boolean | null {
    if (!type.startsWith(GESTURE_PREFIX)) return null
    if (GESTURE_BEGIN.has(type)) {
      // A phantom left by a dropped End would swallow this transition (depth 1 → 2) and every one
      // after it. Clear it first, so this Begin is the outermost one it actually is.
      if (this.depth > 0 && now - this.lastGestureAt >= GESTURE_STALE_MS) this.depth = 0
      this.lastGestureAt = now
      this.depth += 1
      return this.depth === 1 ? true : null
    }
    if (GESTURE_END.has(type)) {
      this.lastGestureAt = now
      if (this.depth === 0) return null
      this.depth -= 1
      return this.depth === 0 ? false : null
    }
    // Update/fling packets: no transition, but they are the proof that the open gesture is live.
    this.lastGestureAt = now
    return null
  }

  /**
   * Force the ledger closed. Returns whether anything was open — i.e. whether the caller still
   * owes the renderer a `false`, so a no-op blur sends no IPC at all.
   */
  reset(): boolean {
    if (this.depth === 0) return false
    this.depth = 0
    return true
  }
}
