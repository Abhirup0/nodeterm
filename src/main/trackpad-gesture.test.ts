import { describe, expect, it } from 'vitest'
import { TrackpadGestureLedger } from './trackpad-gesture'

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
})
