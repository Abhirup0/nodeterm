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
 */

const GESTURE_BEGIN = new Set(['gestureScrollBegin', 'gesturePinchBegin'])
const GESTURE_END = new Set(['gestureScrollEnd', 'gesturePinchEnd'])

export class TrackpadGestureLedger {
  private depth = 0

  /** Feed one raw input-event type; returns the new active state on a transition, null when
   *  nothing changed (the overwhelmingly common case — this runs on every input event). */
  observe(type: string): boolean | null {
    if (GESTURE_BEGIN.has(type)) {
      this.depth += 1
      return this.depth === 1 ? true : null
    }
    if (GESTURE_END.has(type)) {
      if (this.depth === 0) return null
      this.depth -= 1
      return this.depth === 0 ? false : null
    }
    return null
  }
}
