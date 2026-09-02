import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GESTURE_STALE_MS, TrackpadGestureLedger } from './trackpad-gesture'

describe('TrackpadGestureLedger', () => {
  it('reports a transition on the first begin and the matching end', () => {
    const ledger = new TrackpadGestureLedger()
    expect(ledger.observe('gestureScrollBegin')).toBe(true)
    expect(ledger.observe('gestureScrollEnd')).toBe(false)
  })

  it('treats pinch begin/end as trackpad activity too', () => {
    const ledger = new TrackpadGestureLedger()
    expect(ledger.observe('gesturePinchBegin')).toBe(true)
    expect(ledger.observe('gesturePinchEnd')).toBe(false)
  })

  it('stays silent for every non-gesture event (the ~120Hz path)', () => {
    const ledger = new TrackpadGestureLedger()
    expect(ledger.observe('mouseWheel')).toBe(null)
    expect(ledger.observe('pointerRawUpdate')).toBe(null)
    expect(ledger.observe('mouseMove')).toBe(null)
    expect(ledger.observe('keyDown')).toBe(null)
  })

  it('does not repeat a state that has not changed (overlapping gestures nest)', () => {
    // A pinch can begin while a scroll phase is still open; only the OUTERMOST transition is a
    // state change worth an IPC message.
    const ledger = new TrackpadGestureLedger()
    expect(ledger.observe('gestureScrollBegin')).toBe(true)
    expect(ledger.observe('gesturePinchBegin')).toBe(null)
    expect(ledger.observe('gesturePinchEnd')).toBe(null)
    expect(ledger.observe('gestureScrollEnd')).toBe(false)
  })

  it('ignores a stray end with no open gesture instead of going negative', () => {
    const ledger = new TrackpadGestureLedger()
    expect(ledger.observe('gestureScrollEnd')).toBe(null)
    expect(ledger.observe('gestureScrollBegin')).toBe(true)
    expect(ledger.observe('gestureScrollEnd')).toBe(false)
  })

  it('handles the observed touch-phase → momentum-phase sequence as two clean transitions', () => {
    // Empirical shape from a macOS two-finger scroll with a glide (Electron 42, measured):
    // Begin…End for the touch phase, a few mouseWheel packets, then Begin…End for momentum.
    const ledger = new TrackpadGestureLedger()
    expect(ledger.observe('gestureScrollBegin')).toBe(true)
    expect(ledger.observe('mouseWheel')).toBe(null)
    expect(ledger.observe('gestureScrollEnd')).toBe(false)
    expect(ledger.observe('mouseWheel')).toBe(null)
    expect(ledger.observe('gestureScrollBegin')).toBe(true)
    expect(ledger.observe('gestureScrollEnd')).toBe(false)
  })

  // Issue #535: a dropped End used to stick the depth at >= 1 for the life of the window, so no
  // edge transition was ever emitted again and the renderer held gestureActive = true forever —
  // wheel zoom silently dead until restart.
  describe('a dropped gestureScrollEnd', () => {
    it('swallows every later transition without a heal (the regression this guards)', () => {
      const ledger = new TrackpadGestureLedger()
      expect(ledger.observe('gestureScrollBegin', 0)).toBe(true)
      // ... the End never arrives (window blurred / display slept mid-gesture).
      // A later gesture, close enough in time that the staleness guard does not fire:
      expect(ledger.observe('gestureScrollBegin', 100)).toBe(null)
      expect(ledger.observe('gestureScrollEnd', 200)).toBe(null)
      // Still open — this is the phantom the two guards below exist to clear.
      expect(ledger.reset()).toBe(true)
    })

    it('heals on reset(), which reports whether an IPC message is owed', () => {
      const ledger = new TrackpadGestureLedger()
      expect(ledger.observe('gestureScrollBegin', 0)).toBe(true)
      expect(ledger.reset()).toBe(true)
      // A second reset with nothing open owes nothing — an ordinary blur must send no IPC.
      expect(ledger.reset()).toBe(false)
      // And the next real gesture reports both edges again.
      expect(ledger.observe('gestureScrollBegin', 10)).toBe(true)
      expect(ledger.observe('gestureScrollEnd', 20)).toBe(false)
    })

    it('heals on the next Begin once the open gesture has gone stale', () => {
      const ledger = new TrackpadGestureLedger()
      expect(ledger.observe('gestureScrollBegin', 0)).toBe(true)
      const next = GESTURE_STALE_MS
      expect(ledger.observe('gestureScrollBegin', next)).toBe(true)
      expect(ledger.observe('gestureScrollEnd', next + 10)).toBe(false)
    })

    it('does not fire the staleness guard on a live gesture kept open by update packets', () => {
      // A slow pan: gesture packets keep arriving, so the nested pinch below must still nest.
      const ledger = new TrackpadGestureLedger()
      expect(ledger.observe('gestureScrollBegin', 0)).toBe(true)
      for (let t = 500; t <= GESTURE_STALE_MS * 3; t += 500) {
        expect(ledger.observe('gestureScrollUpdate', t)).toBe(null)
      }
      const t = GESTURE_STALE_MS * 3 + 100
      expect(ledger.observe('gesturePinchBegin', t)).toBe(null)
      expect(ledger.observe('gesturePinchEnd', t + 10)).toBe(null)
      expect(ledger.observe('gestureScrollEnd', t + 20)).toBe(false)
    })

    it('never heals on a bare mouseWheel — a live pan is made of those', () => {
      const ledger = new TrackpadGestureLedger()
      expect(ledger.observe('gestureScrollBegin', 0)).toBe(true)
      expect(ledger.observe('mouseWheel', GESTURE_STALE_MS * 10)).toBe(null)
      // Still open: the End is what closes it, never a wheel packet.
      expect(ledger.observe('gestureScrollEnd', GESTURE_STALE_MS * 10 + 1)).toBe(false)
    })
  })
})

describe('main-process wiring (source-level pin)', () => {
  const SRC = readFileSync(join(__dirname, 'index.ts'), 'utf8')

  it('attaches the input-event listener on macOS only', () => {
    // Chromium synthesizes gesture scroll events for touchscreen scrolling on Windows/Linux too,
    // so an unconditional attach bills a touch-enabled non-mac machine for IPC nobody reads.
    const at = SRC.indexOf("win.webContents.on('input-event'")
    expect(at).toBeGreaterThan(0)
    const guard = SRC.lastIndexOf("if (process.platform === 'darwin') {", at)
    expect(guard).toBeGreaterThan(0)
  })

  it('resets the ledger on window blur and tells the renderer', () => {
    expect(SRC).toContain("win.on('blur', () => {")
    expect(SRC).toContain('if (trackpadLedger.reset()) sendGesture(false)')
  })
})
