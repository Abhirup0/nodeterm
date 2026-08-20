import { describe, it, expect } from 'vitest'
import { COMMANDS_BY_ID, type KeybindingOverrides } from '@shared/keybindings'
import {
  matchesShortcutQuery,
  rowPassesStatus,
  shortcutRowStatus,
  type ShortcutStatusFilter
} from './shortcutFilter'

/** Real registry rows, so the pins below fail if the registry moves under them. */
const PALETTE = COMMANDS_BY_ID.get('app.commandPalette')!
const FIT_ALL = COMMANDS_BY_ID.get('canvas.fitAll')!
const UNDO = COMMANDS_BY_ID.get('canvas.undo')!
const COMMIT = COMMANDS_BY_ID.get('scm.commit')!

/** What `rowEntry` in ShortcutsSection feeds the matcher today. */
const KEYWORDS = ['shortcut', 'keybinding', 'hotkey', 'key']

describe('shortcutRowStatus', () => {
  it('is clean for a bound default with no override', () => {
    expect(shortcutRowStatus('canvas.undo', {}, 1)).toEqual({
      modified: false,
      disabled: false,
      unassigned: false
    })
  })

  it('treats a missing overrides map the same as an empty one', () => {
    expect(shortcutRowStatus('canvas.undo', undefined, 1)).toEqual({
      modified: false,
      disabled: false,
      unassigned: false
    })
  })

  it('is modified (only) when the id carries a non-empty override', () => {
    const overrides: KeybindingOverrides = { 'canvas.undo': ['Cmd+Y'] }
    expect(shortcutRowStatus('canvas.undo', overrides, 1)).toEqual({
      modified: true,
      disabled: false,
      unassigned: false
    })
  })

  it('is modified AND disabled but NOT unassigned for an explicit [] override', () => {
    const overrides: KeybindingOverrides = { 'canvas.undo': [] }
    expect(shortcutRowStatus('canvas.undo', overrides, 0)).toEqual({
      modified: true,
      disabled: true,
      unassigned: false
    })
  })

  it('is unassigned but NOT modified for an unbound default (canvas.fitAll)', () => {
    expect(FIT_ALL.defaultBindings.darwin).toEqual([])
    expect(FIT_ALL.defaultBindings.other).toEqual([])
    expect(shortcutRowStatus('canvas.fitAll', {}, 0)).toEqual({
      modified: false,
      disabled: false,
      unassigned: true
    })
  })

  it('is modified AND unassigned when an override happens to leave zero bindings without being []', () => {
    // A sanitizer-shaped edge: the map has the id (so: modified) with a value that is not the
    // disable sentinel, yet nothing effective survives. It must not be reported as `disabled`.
    const overrides = { 'canvas.fitAll': ['Cmd+Alt'] } as unknown as KeybindingOverrides
    expect(shortcutRowStatus('canvas.fitAll', overrides, 0)).toEqual({
      modified: true,
      disabled: false,
      unassigned: true
    })
  })

  it('reads only the queried id out of the map', () => {
    const overrides: KeybindingOverrides = { 'canvas.redo': [] }
    expect(shortcutRowStatus('canvas.undo', overrides, 1).modified).toBe(false)
  })
})

describe('rowPassesStatus', () => {
  const clean = { modified: false, disabled: false, unassigned: false }
  const modified = { modified: true, disabled: false, unassigned: false }
  const disabled = { modified: true, disabled: true, unassigned: false }
  const unassigned = { modified: false, disabled: false, unassigned: true }

  const table: Array<[string, typeof clean, Record<ShortcutStatusFilter, boolean>]> = [
    ['clean', clean, { all: true, modified: false, unassigned: false, disabled: false }],
    ['modified', modified, { all: true, modified: true, unassigned: false, disabled: false }],
    ['disabled', disabled, { all: true, modified: true, unassigned: false, disabled: true }],
    ['unassigned', unassigned, { all: true, modified: false, unassigned: true, disabled: false }]
  ]

  for (const [name, status, expected] of table) {
    for (const filter of ['all', 'modified', 'unassigned', 'disabled'] as ShortcutStatusFilter[]) {
      it(`${name} row under the '${filter}' filter -> ${expected[filter]}`, () => {
        expect(rowPassesStatus(status, filter)).toBe(expected[filter])
      })
    }
  }
})

describe('matchesShortcutQuery', () => {
  it('matches everything on an empty query', () => {
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, [['⌘', 'K']], '')).toBe(true)
    expect(matchesShortcutQuery(FIT_ALL, [], [], '')).toBe(true)
  })

  it('matches everything on a whitespace-only query', () => {
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, [['⌘', 'K']], '   ')).toBe(true)
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, [], '\t\n ')).toBe(true)
  })

  it('matches the title case-insensitively', () => {
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, [['⌘', 'K']], 'PALETTE')).toBe(true)
  })

  it('matches a partial title with surrounding whitespace trimmed', () => {
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, [['⌘', 'K']], '  comm ')).toBe(true)
  })

  it('matches the command id', () => {
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, [['⌘', 'K']], 'app.commandpalette')).toBe(true)
    expect(matchesShortcutQuery(UNDO, KEYWORDS, [['⌘', 'Z']], 'canvas.undo')).toBe(true)
  })

  it('matches the group even when no other field carries the word', () => {
    // `scm.commit` is deliberate: its group is 'Source Control' while its id says 'scm', so a
    // hit on "source" can only have come from the group field.
    expect(COMMIT.group).toBe('Source Control')
    expect(matchesShortcutQuery(COMMIT, [], [['⌘', 'Enter']], 'source')).toBe(true)
  })

  it('matches a supplied keyword that appears nowhere else', () => {
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, [['⌘', 'K']], 'hotkey')).toBe(true)
  })

  it("finds the palette by the chord as shown on mac ('⌘K')", () => {
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, [['⌘', 'K']], '⌘K')).toBe(true)
  })

  it("finds the palette by the word-normalized chord ('cmd+k') on mac parts", () => {
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, [['⌘', 'K']], 'cmd+k')).toBe(true)
  })

  it("finds the palette by the plus join on non-mac parts ('ctrl+k')", () => {
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, [['Ctrl', 'K']], 'ctrl+k')).toBe(true)
  })

  it("keeps the RAW plus join too, so a mixed spelling ('⌘+K') still finds the row", () => {
    // Neither the glyph run (`⌘k`) nor the word form (`cmd+k`) contains this; only
    // `parts.join('+')` does.
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, [['⌘', 'K']], '⌘+K')).toBe(true)
  })

  it('normalizes every glyph in the map', () => {
    const parts = [['⌘', '⇧', '⌥', '⌃', 'B']]
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, parts, 'cmd+shift+alt+ctrl+b')).toBe(true)
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, parts, '⌘⇧⌥⌃B')).toBe(true)
  })

  it('matches on the SECOND binding of a multi-chord command', () => {
    const chords = [['Delete'], ['Backspace']]
    expect(matchesShortcutQuery(UNDO, KEYWORDS, chords, 'backspace')).toBe(true)
  })

  it('does not match a chord the command does not hold', () => {
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, [['⌘', 'K']], 'cmd+j')).toBe(false)
    expect(matchesShortcutQuery(PALETTE, KEYWORDS, [['⌘', 'K']], '⌘J')).toBe(false)
  })

  it('returns false when nothing matches, including for an unbound row', () => {
    expect(matchesShortcutQuery(FIT_ALL, KEYWORDS, [], 'zzz')).toBe(false)
    expect(matchesShortcutQuery(FIT_ALL, KEYWORDS, [], 'fit all')).toBe(true)
  })

  it('tolerates an empty keyword list', () => {
    expect(matchesShortcutQuery(PALETTE, [], [['⌘', 'K']], 'palette')).toBe(true)
    expect(matchesShortcutQuery(PALETTE, [], [['⌘', 'K']], 'hotkey')).toBe(false)
  })

  it('does not bleed one binding into the next when matching a joined chord', () => {
    // Two separate single-key bindings must not answer to the concatenation of both.
    expect(matchesShortcutQuery(UNDO, [], [['A'], ['B']], 'ab')).toBe(false)
    // …nor to a query spanning the seam between two chord spellings of the SAME command.
    expect(matchesShortcutQuery(UNDO, [], [['⌘', 'K'], ['⌘', 'J']], '⌘k ⌘j')).toBe(false)
  })

  it('matches each field independently — a query may not span two fields', () => {
    // The haystack is a LIST, not one joined string: 'Undo canvas.undo' would match a naive
    // `.join(' ').includes(q)`, and so would a query straddling two keywords.
    expect(matchesShortcutQuery(UNDO, [], [], 'undo canvas.undo')).toBe(false)
    expect(matchesShortcutQuery(UNDO, ['alpha', 'beta'], [], 'alpha beta')).toBe(false)
  })

  it('matches a glyph chord case-insensitively', () => {
    expect(matchesShortcutQuery(UNDO, [], [['⌘', 'Z']], '⌘z')).toBe(true)
  })
})
