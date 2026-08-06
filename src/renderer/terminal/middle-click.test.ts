import { describe, expect, it } from 'vitest'
import { suppressMiddleClickPaste } from './middle-click'

/**
 * Issue #84: on Linux a middle click inside a terminal pasted the X PRIMARY selection into the pty,
 * with no way to switch it off — Chromium does it on the hidden textarea xterm keeps under the
 * cursor, and it honours the desktop's `gtk-enable-primary-paste` only in its own Views widgets.
 *
 * `guardMiddleClickPaste` itself needs a DOM and is verified on device; what is pinned here is the
 * DECISION, whose two halves are easy to invert — `allow` is the user's "middle click may paste",
 * so suppression is what happens when it is OFF.
 */
describe('suppressMiddleClickPaste', () => {
  it('suppresses the middle button while the setting is off', () => {
    expect(suppressMiddleClickPaste(1, false)).toBe(true)
  })

  it('lets the middle button through once the user opts in', () => {
    expect(suppressMiddleClickPaste(1, true)).toBe(false)
  })

  it('never touches the other buttons', () => {
    // Left is selection and focus; right is the context menu. Preventing either default would
    // break the terminal in a far more visible way than the bug being fixed.
    for (const button of [0, 2, 3, 4]) {
      expect(suppressMiddleClickPaste(button, false)).toBe(false)
      expect(suppressMiddleClickPaste(button, true)).toBe(false)
    }
  })
})
