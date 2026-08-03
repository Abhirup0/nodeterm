import { describe, expect, it } from 'vitest'
import { CELL_STRIDE, FLAG_BOLD, FLAG_CURSOR, FLAG_ITALIC, FLAG_SELECTED, FLAG_UNDERLINE, FLAG_WIDE, packColor, readCell } from './cells'
import type { GlyphAtlas } from './atlas'
import { packViewportRow, type CellView, type RowFeedOpts, type ThemeLanes } from './feed'

const THEME: ThemeLanes = {
  fg: packColor(0xd0, 0xd1, 0xd2, 0xff),
  bg: packColor(0x10, 0x11, 0x12, 0xff),
  // One distinguishable color per index, so a wrong index is a wrong assertion and not a
  // coincidence: index i is recoverable from any channel.
  ansi: Array.from({ length: 256 }, (_, i) => packColor(i, 0x80, 0xff - i, 0xff)),
  cursorFg: packColor(0x01, 0x02, 0x03, 0xff),
  cursorBg: packColor(0xfa, 0xfb, 0xfc, 0xff),
  selectionBg: packColor(0x30, 0x50, 0x80, 0xff)
}

/** Records every glyphFor call so "the atlas was NOT called" is assertable, and hands back a
 *  distinct non-zero slot per call so a glyph lane can be traced to the call that produced it. */
function fakeAtlas(): Pick<GlyphAtlas, 'glyphFor'> & { calls: Array<[number, boolean, boolean]> } {
  const calls: Array<[number, boolean, boolean]> = []
  return {
    calls,
    glyphFor(code: number, bold: boolean, italic: boolean): number {
      calls.push([code, bold, italic])
      return 900 + calls.length
    }
  }
}

type Attr = 'default' | ['palette', number] | ['rgb', number]

function makeCell(
  o: {
    code?: number
    width?: number
    bold?: boolean
    italic?: boolean
    underline?: boolean
    inverse?: boolean
    dim?: boolean
    fg?: Attr
    bg?: Attr
  } = {}
): CellView {
  const fg: Attr = o.fg ?? 'default'
  const bg: Attr = o.bg ?? 'default'
  const is = (a: Attr, mode: string): boolean => (a === 'default' ? mode === 'default' : a[0] === mode)
  const val = (a: Attr): number => (a === 'default' ? 0 : a[1])
  return {
    getCode: () => o.code ?? 0x41,
    getWidth: () => o.width ?? 1,
    isBold: () => (o.bold ? 1 : 0),
    isItalic: () => (o.italic ? 1 : 0),
    isUnderline: () => (o.underline ? 1 : 0),
    isInverse: () => (o.inverse ? 1 : 0),
    isDim: () => (o.dim ? 1 : 0),
    isFgDefault: () => is(fg, 'default'),
    isFgPalette: () => is(fg, 'palette'),
    isFgRGB: () => is(fg, 'rgb'),
    isBgDefault: () => is(bg, 'default'),
    isBgPalette: () => is(bg, 'palette'),
    isBgRGB: () => is(bg, 'rgb'),
    getFgColor: () => val(fg),
    getBgColor: () => val(bg)
  }
}

function pack(
  cells: readonly (CellView | undefined)[],
  o: Partial<Pick<RowFeedOpts, 'cols' | 'selection' | 'cursorCol' | 'atlas'>> = {}
): { out: Uint32Array; atlas: ReturnType<typeof fakeAtlas> } {
  const atlas = (o.atlas as ReturnType<typeof fakeAtlas>) ?? fakeAtlas()
  const cols = o.cols ?? cells.length
  const out = new Uint32Array(cols * CELL_STRIDE)
  packViewportRow(out, (col) => cells[col], makeCell(), {
    cols,
    atlas,
    theme: THEME,
    selection: o.selection ?? null,
    cursorCol: o.cursorCol ?? -1
  })
  return { out, atlas }
}

const halve = (c: number): number =>
  packColor((c & 0xff) >>> 1, ((c >>> 8) & 0xff) >>> 1, ((c >>> 16) & 0xff) >>> 1, (c >>> 24) & 0xff)

describe('packViewportRow — colors', () => {
  it('default fg/bg resolve to the theme lanes and the glyph comes from the atlas', () => {
    const { out, atlas } = pack([makeCell({ code: 0x41 })])
    expect(readCell(out, 0)).toEqual({ glyph: 901, fg: THEME.fg, bg: THEME.bg, flags: 0 })
    expect(atlas.calls).toEqual([[0x41, false, false]])
  })

  it('palette fg/bg index into theme.ansi', () => {
    const { out } = pack([makeCell({ fg: ['palette', 2], bg: ['palette', 250] })])
    const c = readCell(out, 0)
    expect(c.fg).toBe(THEME.ansi[2])
    expect(c.bg).toBe(THEME.ansi[250])
  })

  it('an out-of-range palette index falls back to the theme default rather than undefined', () => {
    const { out } = pack([makeCell({ fg: ['palette', 999], bg: ['palette', -1] })])
    const c = readCell(out, 0)
    expect(c.fg).toBe(THEME.fg)
    expect(c.bg).toBe(THEME.bg)
  })

  it('RGB colors pack 0xRRGGBB into opaque lanes', () => {
    const { out } = pack([makeCell({ fg: ['rgb', 0xaabbcc], bg: ['rgb', 0x123456] })])
    const c = readCell(out, 0)
    expect(c.fg).toBe(packColor(0xaa, 0xbb, 0xcc, 0xff))
    expect(c.bg).toBe(packColor(0x12, 0x34, 0x56, 0xff))
  })

  it('inverse swaps the RESOLVED pair (palette fg on default bg)', () => {
    const { out } = pack([makeCell({ fg: ['palette', 2], inverse: true })])
    const c = readCell(out, 0)
    expect(c.fg).toBe(THEME.bg)
    expect(c.bg).toBe(THEME.ansi[2])
  })

  it('dim halves the fg RGB channels and keeps alpha', () => {
    const { out } = pack([makeCell({ fg: ['rgb', 0xff0f01], dim: true })])
    expect(readCell(out, 0).fg).toBe(packColor(0x7f, 0x07, 0x00, 0xff))
  })

  it('dim applies AFTER inverse — it halves the swapped foreground, not the original', () => {
    const { out } = pack([makeCell({ fg: ['palette', 2], dim: true, inverse: true })])
    const c = readCell(out, 0)
    expect(c.fg).toBe(halve(THEME.bg)) // the bg that inverse moved into the fg slot
    expect(c.bg).toBe(THEME.ansi[2]) // background is never dimmed
  })
})

describe('packViewportRow — attributes', () => {
  it('bold picks the bold glyph variant and sets FLAG_BOLD (no bright-color promotion in v1)', () => {
    const { out, atlas } = pack([makeCell({ code: 0x42, bold: true, fg: ['palette', 1] })])
    expect(atlas.calls).toEqual([[0x42, true, false]])
    const c = readCell(out, 0)
    expect(c.flags).toBe(FLAG_BOLD)
    expect(c.fg).toBe(THEME.ansi[1]) // NOT promoted to ansi[9]
  })

  it('italic and underline set their flags; italic reaches the atlas key', () => {
    const { out, atlas } = pack([makeCell({ code: 0x43, italic: true, underline: true })])
    expect(atlas.calls).toEqual([[0x43, false, true]])
    expect(readCell(out, 0).flags).toBe(FLAG_ITALIC | FLAG_UNDERLINE)
  })
})

describe('packViewportRow — wide and zero-width cells', () => {
  it('a wide char paints its glyph in the lead cell and a blank, bg-continuous continuation', () => {
    const wide = makeCell({ code: 0x4e2d, width: 2, bg: ['rgb', 0x223344] })
    const cont = makeCell({ code: 0, width: 0, bg: ['rgb', 0x223344] })
    const { out, atlas } = pack([wide, cont])
    const lead = readCell(out, 0)
    const tail = readCell(out, 1)
    expect(lead.glyph).toBe(901)
    expect(lead.flags & FLAG_WIDE).toBe(FLAG_WIDE)
    expect(tail.glyph).toBe(0) // blank slot — the lead's ink covers both columns
    expect(tail.bg).toBe(lead.bg) // unbroken background run under the glyph
    expect(tail.fg).toBe(lead.fg)
    expect(atlas.calls).toEqual([[0x4e2d, false, false]]) // the continuation asks for no glyph
  })

  it('a zero-width cell with no wide lead before it still writes a blank cell (never stale)', () => {
    // The row buffer is reused across frames, so "write nothing" would leave the PREVIOUS
    // frame's lanes at that column. Every column is always written.
    const out = new Uint32Array(1 * CELL_STRIDE)
    out.fill(0xdeadbeef)
    packViewportRow(out, () => makeCell({ code: 0x300, width: 0, bg: ['rgb', 0x010203] }), makeCell(), {
      cols: 1,
      atlas: fakeAtlas(),
      theme: THEME,
      selection: null,
      cursorCol: -1
    })
    const c = readCell(out, 0)
    expect(c.glyph).toBe(0)
    expect(c.bg).toBe(packColor(0x01, 0x02, 0x03, 0xff))
  })

  it('a wide lead in the last column does not write past the row', () => {
    const out = new Uint32Array(1 * CELL_STRIDE)
    packViewportRow(out, () => makeCell({ code: 0x4e2d, width: 2 }), makeCell(), {
      cols: 1,
      atlas: fakeAtlas(),
      theme: THEME,
      selection: null,
      cursorCol: -1
    })
    expect(out.length).toBe(CELL_STRIDE)
    expect(readCell(out, 0).glyph).toBe(901)
  })
})

describe('packViewportRow — code point validation', () => {
  // Guards the rasterizer's String.fromCodePoint: a lone surrogate or an out-of-range code point
  // THROWS there, taking the whole frame down. The atlas must never see one.
  const invalid: Array<[string, number]> = [
    ['NUL', 0],
    ['a control char', 0x1f],
    ['a low surrogate boundary', 0xd800],
    ['a high surrogate boundary', 0xdfff],
    ['past the Unicode range', 0x110000],
    ['a negative code', -1],
    ['a non-integer code', 1.5],
    ['NaN', Number.NaN]
  ]
  for (const [label, code] of invalid) {
    it(`maps ${label} to the blank slot without calling the atlas`, () => {
      const { out, atlas } = pack([makeCell({ code })])
      expect(readCell(out, 0).glyph).toBe(0)
      expect(atlas.calls).toEqual([])
    })
  }

  it('a space is blank without a lookup, and the first printable code is rasterized', () => {
    const { out, atlas } = pack([makeCell({ code: 0x20 }), makeCell({ code: 0x21 })])
    expect(readCell(out, 0).glyph).toBe(0)
    expect(readCell(out, 1).glyph).toBe(901)
    expect(atlas.calls).toEqual([[0x21, false, false]])
  })
})

describe('packViewportRow — cursor and selection', () => {
  it('the cursor cell paints cursorBg/cursorFg and sets FLAG_CURSOR', () => {
    const { out } = pack([makeCell(), makeCell({ fg: ['palette', 3] })], { cursorCol: 1 })
    expect(readCell(out, 0).flags).toBe(0)
    const c = readCell(out, 1)
    expect(c.fg).toBe(THEME.cursorFg)
    expect(c.bg).toBe(THEME.cursorBg)
    expect(c.flags).toBe(FLAG_CURSOR)
  })

  it('a selection span [start, endExcl) repaints only its bg, leaving fg resolved', () => {
    const cells = [0, 1, 2, 3].map(() => makeCell({ fg: ['palette', 4] }))
    const { out } = pack(cells, { selection: [1, 3] })
    expect(readCell(out, 0).bg).toBe(THEME.bg)
    for (const col of [1, 2]) {
      const c = readCell(out, col)
      expect(c.bg).toBe(THEME.selectionBg)
      expect(c.fg).toBe(THEME.ansi[4]) // fg is untouched by selection
      expect(c.flags).toBe(FLAG_SELECTED)
    }
    expect(readCell(out, 3).bg).toBe(THEME.bg) // end is EXCLUSIVE
    expect(readCell(out, 3).flags).toBe(0)
  })

  it('cursor wins over selection on overlap; both state flags stay set', () => {
    const { out } = pack([makeCell(), makeCell(), makeCell()], { selection: [0, 3], cursorCol: 1 })
    const c = readCell(out, 1)
    expect(c.bg).toBe(THEME.cursorBg)
    expect(c.fg).toBe(THEME.cursorFg)
    expect(c.flags).toBe(FLAG_SELECTED | FLAG_CURSOR)
    expect(readCell(out, 0).bg).toBe(THEME.selectionBg)
  })

  it('a null selection and cursorCol -1 paint nothing', () => {
    const { out } = pack([makeCell()], { selection: null, cursorCol: -1 })
    expect(readCell(out, 0).flags).toBe(0)
  })
})

describe('packViewportRow — missing cells and buffer reuse', () => {
  it('a column past the end of the line becomes a blank cell on the theme background', () => {
    const { out } = pack([makeCell(), undefined], { cols: 2 })
    expect(readCell(out, 1)).toEqual({ glyph: 0, fg: THEME.fg, bg: THEME.bg, flags: 0 })
  })

  it('the cursor still paints on a column past the end of the line', () => {
    // The most common cursor position of all: one past the last typed character.
    const { out } = pack([makeCell(), undefined], { cols: 2, cursorCol: 1 })
    const c = readCell(out, 1)
    expect(c.bg).toBe(THEME.cursorBg)
    expect(c.flags).toBe(FLAG_CURSOR)
  })

  it('every column of a reused row buffer is overwritten — no stale lanes survive', () => {
    const out = new Uint32Array(3 * CELL_STRIDE)
    out.fill(0xdeadbeef)
    packViewportRow(out, (col) => (col === 1 ? undefined : makeCell({ code: 0x20 })), makeCell(), {
      cols: 3,
      atlas: fakeAtlas(),
      theme: THEME,
      selection: null,
      cursorCol: -1
    })
    for (let col = 0; col < 3; col++) {
      expect(readCell(out, col)).toEqual({ glyph: 0, fg: THEME.fg, bg: THEME.bg, flags: 0 })
    }
  })

  it('hands the caller-owned work cell to readCell so the shell can fill it in place', () => {
    const work = makeCell({ code: 0x5a })
    const seen: Array<CellView | undefined> = []
    const out = new Uint32Array(2 * CELL_STRIDE)
    packViewportRow(
      out,
      (_col, into) => {
        seen.push(into)
        return into
      },
      work,
      { cols: 2, atlas: fakeAtlas(), theme: THEME, selection: null, cursorCol: -1 }
    )
    expect(seen).toEqual([work, work])
    expect(readCell(out, 0).glyph).toBe(901)
  })
})
