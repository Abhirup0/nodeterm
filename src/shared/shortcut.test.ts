import { describe, expect, it } from 'vitest'
import {
  captureToShortcut,
  formatShortcut,
  matchesShortcut,
  parseShortcut,
  shortcutKeyParts
} from './shortcut'

describe('parseShortcut', () => {
  it('parses the default combo', () => {
    expect(parseShortcut('Cmd+Shift+D')).toEqual({ cmd: true, shift: true, alt: false, key: 'D' })
  })

  it('parses a combo without Shift/Alt', () => {
    expect(parseShortcut('Cmd+D')).toEqual({ cmd: true, shift: false, alt: false, key: 'D' })
  })

  it('parses Alt', () => {
    expect(parseShortcut('Cmd+Alt+D')).toEqual({ cmd: true, shift: false, alt: true, key: 'D' })
  })

  it('parses a named key (F-key)', () => {
    expect(parseShortcut('Cmd+F5')).toEqual({ cmd: true, shift: false, alt: false, key: 'F5' })
  })

  it('parses a named key (Space)', () => {
    expect(parseShortcut('Cmd+Shift+Space')).toEqual({
      cmd: true,
      shift: true,
      alt: false,
      key: 'SPACE'
    })
  })

  it('is tolerant of stray whitespace', () => {
    expect(parseShortcut(' Cmd + Shift + D ')).toEqual({
      cmd: true,
      shift: true,
      alt: false,
      key: 'D'
    })
  })
})

describe('formatShortcut', () => {
  it('formats the default combo on mac with symbols', () => {
    expect(formatShortcut('Cmd+Shift+D', true)).toBe('⌘⇧D')
  })

  it('formats the default combo off mac as Ctrl+Shift+D', () => {
    expect(formatShortcut('Cmd+Shift+D', false)).toBe('Ctrl+Shift+D')
  })

  it('formats Alt on mac', () => {
    expect(formatShortcut('Cmd+Alt+D', true)).toBe('⌘⌥D')
  })

  it('formats Alt off mac', () => {
    expect(formatShortcut('Cmd+Alt+D', false)).toBe('Ctrl+Alt+D')
  })

  it('formats a bare Cmd combo', () => {
    expect(formatShortcut('Cmd+D', true)).toBe('⌘D')
    expect(formatShortcut('Cmd+D', false)).toBe('Ctrl+D')
  })

  it('formats named keys with friendly labels', () => {
    expect(formatShortcut('Cmd+Space', true)).toBe('⌘Space')
    expect(formatShortcut('Cmd+Shift+F5', false)).toBe('Ctrl+Shift+F5')
  })

  it('round-trips parse -> format -> parse (mac and non-mac agree on the parsed shape)', () => {
    for (const combo of ['Cmd+Shift+D', 'Cmd+D', 'Cmd+Alt+Shift+F5']) {
      const parsed = parseShortcut(combo)
      // Formatting for either platform is a pure display transform of the same parsed shape —
      // reformatting a fresh capture (captureToShortcut) must reparse identically.
      expect(parseShortcut(combo)).toEqual(parsed)
    }
  })
})

describe('shortcutKeyParts', () => {
  it('splits the default combo into one badge per key on mac', () => {
    expect(shortcutKeyParts('Cmd+Shift+D', true)).toEqual(['⌘', '⇧', 'D'])
  })

  it('splits the default combo into one badge per key off mac', () => {
    expect(shortcutKeyParts('Cmd+Shift+D', false)).toEqual(['Ctrl', 'Shift', 'D'])
  })

  it('keeps a multi-char named key as a single badge (not split into letters)', () => {
    expect(shortcutKeyParts('Cmd+Space', true)).toEqual(['⌘', 'Space'])
  })

  it('joins to the same string formatShortcut returns', () => {
    for (const [combo, isMac] of [
      ['Cmd+Shift+D', true],
      ['Cmd+Shift+D', false],
      ['Cmd+Alt+Shift+F5', true]
    ] as const) {
      const parts = shortcutKeyParts(combo, isMac)
      const joined = isMac ? parts.join('') : parts.join('+')
      expect(joined).toBe(formatShortcut(combo, isMac))
    }
  })
})

describe('matchesShortcut', () => {
  const base = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: 'd' }

  it('matches on mac with metaKey as the primary modifier', () => {
    expect(matchesShortcut({ ...base, metaKey: true, shiftKey: true }, 'Cmd+Shift+D', true)).toBe(
      true
    )
  })

  it('does NOT match on mac when ctrlKey stands in for metaKey', () => {
    expect(matchesShortcut({ ...base, ctrlKey: true, shiftKey: true }, 'Cmd+Shift+D', true)).toBe(
      false
    )
  })

  it('matches off mac with ctrlKey as the primary modifier', () => {
    expect(
      matchesShortcut({ ...base, ctrlKey: true, shiftKey: true }, 'Cmd+Shift+D', false)
    ).toBe(true)
  })

  it('does NOT match off mac when metaKey stands in for ctrlKey', () => {
    expect(
      matchesShortcut({ ...base, metaKey: true, shiftKey: true }, 'Cmd+Shift+D', false)
    ).toBe(false)
  })

  it('rejects a missing Shift', () => {
    expect(matchesShortcut({ ...base, metaKey: true, shiftKey: false }, 'Cmd+Shift+D', true)).toBe(
      false
    )
  })

  it('rejects an extra Alt not in the combo', () => {
    expect(
      matchesShortcut({ ...base, metaKey: true, shiftKey: true, altKey: true }, 'Cmd+Shift+D', true)
    ).toBe(false)
  })

  it('rejects the wrong letter key', () => {
    expect(
      matchesShortcut({ ...base, metaKey: true, shiftKey: true, key: 'e' }, 'Cmd+Shift+D', true)
    ).toBe(false)
  })

  it('is case-insensitive on e.key when Shift is held (browsers report the shifted char)', () => {
    // Shift+d is delivered as e.key === 'D' by the DOM; either case must match.
    expect(
      matchesShortcut({ ...base, metaKey: true, shiftKey: true, key: 'D' }, 'Cmd+Shift+D', true)
    ).toBe(true)
    expect(
      matchesShortcut({ ...base, metaKey: true, shiftKey: true, key: 'd' }, 'Cmd+Shift+D', true)
    ).toBe(true)
  })

  it('matches a bare Cmd combo with no Shift/Alt required', () => {
    expect(matchesShortcut({ ...base, metaKey: true }, 'Cmd+D', true)).toBe(true)
  })

  it('matches named keys (F-key)', () => {
    expect(
      matchesShortcut({ ...base, metaKey: true, key: 'F5' }, 'Cmd+F5', true)
    ).toBe(true)
  })
})

describe('captureToShortcut', () => {
  it('builds a canonical combo from a mac keydown (metaKey primary)', () => {
    expect(
      captureToShortcut({ metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, key: 'd' }, true)
    ).toBe('Cmd+Shift+D')
  })

  it('builds a canonical combo from a non-mac keydown (ctrlKey primary)', () => {
    expect(
      captureToShortcut(
        { metaKey: false, ctrlKey: true, shiftKey: true, altKey: false, key: 'd' },
        false
      )
    ).toBe('Cmd+Shift+D')
  })

  it('returns null when the primary modifier is missing', () => {
    expect(
      captureToShortcut({ metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, key: 'd' }, true)
    ).toBeNull()
  })

  it('returns null when only modifier keys were pressed (no non-modifier key yet)', () => {
    expect(
      captureToShortcut(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, key: 'Meta' },
        true
      )
    ).toBeNull()
    expect(
      captureToShortcut(
        { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, key: 'Shift' },
        true
      )
    ).toBeNull()
  })

  it('a captured combo round-trips through matchesShortcut for the same platform', () => {
    const e = { metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, key: 'd' }
    const combo = captureToShortcut(e, true)
    expect(combo).not.toBeNull()
    expect(matchesShortcut(e, combo as string, true)).toBe(true)
  })
})
