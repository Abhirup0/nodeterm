import { describe, expect, it } from 'vitest'
import { parsePaneCursor } from './pane-cursor'

/**
 * The interesting cases here are the REFUSALS.
 *
 * The caller's fallback for `undefined` is "leave the cursor where the paint left it" — the
 * behaviour this whole path replaces, so a refusal costs nothing that was not already lost. A
 * half-parsed reply is the opposite: it would place the cursor at a position the pane never had,
 * which is worse than the bug being fixed.
 */
describe('parsePaneCursor', () => {
  it('reads the three fields tmux reports', () => {
    expect(parsePaneCursor('6 1 1')).toEqual({ x: 6, y: 1, visible: true })
    expect(parsePaneCursor('0 0 0')).toEqual({ x: 0, y: 0, visible: false })
  })

  it('tolerates the whitespace a shell round trip adds', () => {
    // The remote path runs through `ssh` and a login shell, so a trailing newline is the norm.
    expect(parsePaneCursor('12 3 1\n')).toEqual({ x: 12, y: 3, visible: true })
    expect(parsePaneCursor('  12   3   1  ')).toEqual({ x: 12, y: 3, visible: true })
  })

  it('refuses a reply that is not three fields', () => {
    expect(parsePaneCursor('')).toBeUndefined() // dead ControlMaster, session just died
    expect(parsePaneCursor('6 1')).toBeUndefined()
    expect(parsePaneCursor('6 1 1 1')).toBeUndefined()
  })

  it("refuses tmux's own error text, which arrives on stdout", () => {
    expect(parsePaneCursor("can't find pane: nt-abc")).toBeUndefined()
  })

  it('refuses a format string echoed back by a tmux that does not know the fields', () => {
    expect(parsePaneCursor('#{cursor_x} #{cursor_y} #{cursor_flag}')).toBeUndefined()
  })

  it('refuses non-integer or negative coordinates', () => {
    expect(parsePaneCursor('6.5 1 1')).toBeUndefined()
    expect(parsePaneCursor('-1 1 1')).toBeUndefined()
    expect(parsePaneCursor('6 -1 1')).toBeUndefined()
  })

  it('reads the visibility flag strictly rather than guessing', () => {
    // Guessing wrong either hides a cursor the user is looking for, or paints one over a
    // full-screen TUI that deliberately hid it.
    expect(parsePaneCursor('6 1 2')).toBeUndefined()
    expect(parsePaneCursor('6 1 yes')).toBeUndefined()
    expect(parsePaneCursor('6 1 ')).toBeUndefined()
  })
})
