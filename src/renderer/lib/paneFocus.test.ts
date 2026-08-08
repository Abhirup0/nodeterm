import { describe, expect, it } from 'vitest'
import { shouldReleasePaneFocus } from './paneFocus'

const el = (tagName: string, contentEditable = false): Element =>
  ({ tagName, isContentEditable: contentEditable }) as unknown as Element

/**
 * Issue #86: a click on empty canvas left a sticky note's textarea focused, so everything typed
 * afterwards went into the note — noticed as spaces (a Figma space-to-pan reflex) landing in a note
 * the user had not touched, but it applies to every key, and it also kept the canvas shortcuts
 * suppressed the whole time.
 */
describe('shouldReleasePaneFocus', () => {
  it('releases a text-entry surface — the one that swallows typing', () => {
    expect(shouldReleasePaneFocus(el('TEXTAREA'))).toBe(true)
    expect(shouldReleasePaneFocus(el('INPUT'))).toBe(true)
    expect(shouldReleasePaneFocus(el('DIV', true))).toBe(true)
  })

  it('leaves anything else alone', () => {
    // Blurring a focused button or node div would fight the browser's own focus handling for no
    // gain: neither of them eats a keystroke.
    expect(shouldReleasePaneFocus(el('BUTTON'))).toBe(false)
    expect(shouldReleasePaneFocus(el('DIV'))).toBe(false)
    expect(shouldReleasePaneFocus(el('BODY'))).toBe(false)
  })

  it('answers false when nothing is focused, so the common click costs nothing', () => {
    expect(shouldReleasePaneFocus(null)).toBe(false)
  })
})
