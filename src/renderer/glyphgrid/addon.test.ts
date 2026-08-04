import { describe, expect, it } from 'vitest'
import type { GlyphAtlas } from './atlas'
import { CELL_STRIDE, FLAG_CURSOR, FLAG_SELECTED, packColor, readCell } from './cells'
import type { GridCursor } from './cursor'
import type { GridHandle } from './engine'
import {
  GlyphGridRendererAddonCore,
  type DeviceMetrics,
  type TermInternals
} from './addon'
import type { DecorationReader } from './decorations'
import type { CellView, ThemeLanes } from './feed'

const THEME: ThemeLanes = {
  fg: packColor(0xd0, 0xd1, 0xd2, 0xff),
  bg: packColor(0x10, 0x11, 0x12, 0xff),
  ansi: Array.from({ length: 256 }, (_, i) => packColor(i, 0x80, 0xff - i, 0xff)),
  cursorFg: packColor(0x01, 0x02, 0x03, 0xff),
  cursorBg: packColor(0xfa, 0xfb, 0xfc, 0xff),
  selectionBg: packColor(0x30, 0x50, 0x80, 0xff)
}

/** A cell whose code point encodes the ABSOLUTE buffer row it came from, so a packed row can be
 *  traced back to the buffer row that produced it — which is the whole point of the mapping
 *  tests (a viewportY off-by-one is otherwise invisible). */
function rowCodedCell(absRow: number, col: number): CellView {
  const code = 0x100 + absRow * 16 + col
  return {
    getChars: () => String.fromCodePoint(code),
    getCode: () => code,
    getWidth: () => 1,
    isBold: () => 0,
    isItalic: () => 0,
    isUnderline: () => 0,
    isInverse: () => 0,
    isDim: () => 0,
    isFgDefault: () => true,
    isFgPalette: () => false,
    isFgRGB: () => false,
    isBgDefault: () => true,
    isBgPalette: () => false,
    isBgRGB: () => false,
    getFgColor: () => 0,
    getBgColor: () => 0
  }
}

interface RecordedRow {
  row: number
  /** Copy — the core reuses ONE row buffer, so keeping the live reference would record the last
   *  frame N times. */
  cells: Uint32Array
  /** The buffer INSTANCE handed to updateRow, kept only to assert the reuse contract. */
  buf: Uint32Array
}

function recordingHandle(): GridHandle & {
  rows: RecordedRow[]
  log: string[]
  resizes: Array<[number, number]>
  /** Every cursor spec pushed to the grid, newest last — `at(-1)` is what a frame would draw. */
  cursors: Array<GridCursor | null>
} {
  const rows: RecordedRow[] = []
  const log: string[] = []
  const resizes: Array<[number, number]> = []
  const cursors: Array<GridCursor | null> = []
  return {
    rows,
    log,
    resizes,
    cursors,
    updateRow(row, cells) {
      log.push(`updateRow:${row}`)
      rows.push({ row, cells: cells.slice(), buf: cells })
    },
    setOrigin() {},
    // The addon owns CELLS, never geometry — the plate is the node's business. A stub, present
    // only to satisfy the handle contract.
    setPlateRect() {},
    setCursor(cursor) {
      cursors.push(cursor)
    },
    setZ() {},
    resize(cols, r) {
      log.push(`resize:${cols}x${r}`)
      resizes.push([cols, r])
    },
    dispose() {
      log.push('dispose')
    }
  }
}

/** The atlas surface the addon holds: a slot source AND a reset broadcaster.
 *
 *  `fireReset()` is the test's hand on the real atlas's most awkward behaviour — a reset fires
 *  SYNCHRONOUSLY inside a `glyphFor` call, i.e. in the middle of someone's row pack — so
 *  `onGlyphFor` exists to fire it from exactly there. */
function recordingAtlas(o: { onGlyphFor?: (fire: () => void) => void } = {}): Pick<
  GlyphAtlas,
  'glyphFor' | 'onReset'
> & { fireReset(): void; subCount(): number } {
  const subs = new Set<() => void>()
  const fireReset = (): void => {
    for (const cb of [...subs]) cb()
  }
  return {
    // Identity-ish: the slot IS derived from the code point, so a packed glyph lane names the cell
    // it came from without a second bookkeeping structure.
    glyphFor: (code) => {
      o.onGlyphFor?.(fireReset)
      return code
    },
    onReset: (cb) => {
      subs.add(cb)
      return {
        dispose: (): void => {
          subs.delete(cb)
        }
      }
    },
    fireReset,
    subCount: () => subs.size
  }
}

/** The decoration surface the shell hands over: a reader plus the two "something changed" events.
 *  `fire*` is the test's hand on xterm's decoration service — the search addon registering a hit. */
function fakeDecorations(
  entries: Array<{ col: number; row: number; layer?: string; bg?: number; fg?: number }> = []
): {
  reader: DecorationReader
  onDecorationRegistered(cb: () => void): { dispose(): void }
  onDecorationRemoved(cb: () => void): { dispose(): void }
  fireRegistered(): void
  fireRemoved(): void
  subCount(): number
} {
  const registered = new Set<() => void>()
  const removed = new Set<() => void>()
  const sub = (set: Set<() => void>, cb: () => void): { dispose(): void } => {
    set.add(cb)
    return {
      dispose: (): void => {
        set.delete(cb)
      }
    }
  }
  return {
    reader: {
      empty: () => entries.length === 0,
      atCell: (col, row, cb) => entries.filter((e) => e.col === col && e.row === row).forEach(cb)
    },
    onDecorationRegistered: (cb) => sub(registered, cb),
    onDecorationRemoved: (cb) => sub(removed, cb),
    fireRegistered: () => {
      for (const cb of [...registered]) cb()
    },
    fireRemoved: () => {
      for (const cb of [...removed]) cb()
    },
    subCount: () => registered.size + removed.size
  }
}

interface FakeTermOpts {
  cols?: number
  rows?: number
  viewportY?: number
  baseY?: number
  cursorX?: number
  cursorY?: number
  cursorVisible?: boolean
  focus?: boolean
  decorations?: ReturnType<typeof fakeDecorations>
  /** xterm's two cursor options, verbatim. ABSENT on purpose in every test that does not name them:
   *  an xterm build that stopped reporting them must degrade to xterm's own defaults (a focused
   *  block, a blurred outline), never to no cursor at all. */
  cursorStyle?: { style?: string; inactiveStyle?: string }
  /** Columns whose cell reports width 2 — a wide glyph's LEAD. The column after one reports width
   *  0, exactly as xterm's buffer stores a double-width character. */
  wideCols?: readonly number[]
}

type FakeTermState = Required<Omit<FakeTermOpts, 'decorations' | 'cursorStyle' | 'wideCols'>>

function fakeTerm(o: FakeTermOpts = {}): TermInternals & { state: FakeTermState } {
  const state: FakeTermState = {
    cols: o.cols ?? 4,
    rows: o.rows ?? 6,
    viewportY: o.viewportY ?? 0,
    baseY: o.baseY ?? 0,
    cursorX: o.cursorX ?? 0,
    cursorY: o.cursorY ?? 0,
    cursorVisible: o.cursorVisible ?? true,
    focus: o.focus ?? true
  }
  const workCell = rowCodedCell(-1, -1)
  return {
    state,
    cols: () => state.cols,
    rows: () => state.rows,
    viewportY: () => state.viewportY,
    baseY: () => state.baseY,
    cursorX: () => state.cursorX,
    cursorY: () => state.cursorY,
    cursorVisible: () => state.cursorVisible,
    readCell: (absRow, col) => {
      const wide = o.wideCols ?? []
      if (wide.includes(col)) return { ...rowCodedCell(absRow, col), getWidth: () => 2 }
      if (wide.includes(col - 1)) return { ...rowCodedCell(absRow, col), getWidth: () => 0 }
      return rowCodedCell(absRow, col)
    },
    makeWorkCell: () => workCell,
    deviceMetrics: () => ({ charW: 16, charH: 34, cellW: 16, cellH: 34 }),
    dpr: () => 2,
    theme: () => THEME,
    hasFocus: () => state.focus,
    // Absent unless a test names them — see FakeTermOpts.cursorStyle.
    cursorStyle: o.cursorStyle ? () => o.cursorStyle as { style?: string } : undefined,
    // Absent unless a test asks for them — an xterm build with no decoration service hands the
    // addon exactly this, and every other test in this file is that case.
    decorations: o.decorations?.reader,
    onDecorationRegistered: o.decorations?.onDecorationRegistered,
    onDecorationRemoved: o.decorations?.onDecorationRemoved
  }
}

function make(
  o: FakeTermOpts & { atlas?: ReturnType<typeof recordingAtlas> } = {}
): {
  core: GlyphGridRendererAddonCore
  term: ReturnType<typeof fakeTerm>
  handle: ReturnType<typeof recordingHandle>
  atlas: ReturnType<typeof recordingAtlas>
} {
  const term = fakeTerm(o)
  const handle = recordingHandle()
  const atlas = o.atlas ?? recordingAtlas()
  const core = new GlyphGridRendererAddonCore(term, handle, atlas)
  return { core, term, handle, atlas }
}

/** The glyph lane of a packed row decodes back to (absRow, col) — see rowCodedCell. */
function decodeRow(cells: Uint32Array, cols: number): Array<{ absRow: number; col: number }> {
  const out: Array<{ absRow: number; col: number }> = []
  for (let c = 0; c < cols; c++) {
    const g = readCell(cells, c).glyph
    out.push({ absRow: Math.floor((g - 0x100) / 16), col: (g - 0x100) % 16 })
  }
  return out
}

describe('GlyphGridRendererAddonCore.renderRows', () => {
  it('packs exactly the requested viewport rows, mapped through viewportY', () => {
    const { core, handle } = make({ viewportY: 0 })
    core.renderRows(2, 4)
    expect(handle.rows.map((r) => r.row)).toEqual([2, 3, 4])
    for (const rec of handle.rows) {
      // Every column of the row came from the SAME absolute buffer row, and that row is the
      // viewport row (viewportY = 0).
      expect(decodeRow(rec.cells, 4).map((d) => d.absRow)).toEqual([rec.row, rec.row, rec.row, rec.row])
      expect(decodeRow(rec.cells, 4).map((d) => d.col)).toEqual([0, 1, 2, 3])
    }
  })

  it('maps a SCROLLED buffer: viewport row r reads absolute row viewportY + r', () => {
    const { core, handle } = make({ viewportY: 100, baseY: 140 })
    core.renderRows(0, 1)
    expect(handle.rows.map((r) => r.row)).toEqual([0, 1])
    expect(decodeRow(handle.rows[0].cells, 4)[0].absRow).toBe(100)
    expect(decodeRow(handle.rows[1].cells, 4)[0].absRow).toBe(101)
  })

  it('clamps the requested range to the grid', () => {
    const { core, handle } = make({ rows: 3 })
    core.renderRows(-5, 99)
    expect(handle.rows.map((r) => r.row)).toEqual([0, 1, 2])
  })

  it('reuses ONE row buffer across rows (allocation-free hot path)', () => {
    const { core, handle } = make()
    core.renderRows(0, 3)
    const first = handle.rows[0].buf
    for (const rec of handle.rows) expect(rec.buf).toBe(first)
    expect(first.length).toBe(4 * CELL_STRIDE)
  })

  it('paints the block cursor on the cursor row, converted from base-relative coords', () => {
    // Cursor sits at buffer row baseY + cursorY = 140 + 3 = 143; the viewport starts at 140, so
    // it belongs on viewport row 3.
    const { core, handle } = make({ viewportY: 140, baseY: 140, cursorY: 3, cursorX: 2 })
    core.renderRows(0, 5)
    const flagsOn = (row: number, col: number): number =>
      readCell(handle.rows.find((r) => r.row === row)!.cells, col).flags & FLAG_CURSOR
    expect(flagsOn(3, 2)).toBe(FLAG_CURSOR)
    expect(flagsOn(3, 1)).toBe(0)
    expect(flagsOn(2, 2)).toBe(0)
  })

  it('clamps a deferred-wrap cursor (x === cols) onto the last column', () => {
    const { core, handle } = make({ cols: 4, rows: 2, cursorX: 4, cursorY: 0 })
    core.renderRows(0, 1)
    const row0 = handle.rows.find((r) => r.row === 0)!
    expect(readCell(row0.cells, 3).flags & FLAG_CURSOR).toBe(FLAG_CURSOR)
    expect(readCell(row0.cells, 2).flags & FLAG_CURSOR).toBe(0)
  })

  it('paints NO cursor while the cursor is hidden or the terminal is blurred', () => {
    const hidden = make({ cursorVisible: false, cursorY: 1, cursorX: 1 })
    hidden.core.renderRows(0, 2)
    for (const rec of hidden.handle.rows)
      for (let c = 0; c < 4; c++) expect(readCell(rec.cells, c).flags & FLAG_CURSOR).toBe(0)

    const blurred = make({ focus: false, cursorY: 1, cursorX: 1 })
    blurred.core.renderRows(0, 2)
    for (const rec of blurred.handle.rows)
      for (let c = 0; c < 4; c++) expect(readCell(rec.cells, c).flags & FLAG_CURSOR).toBe(0)
  })
})

describe('GlyphGridRendererAddonCore.handleResize', () => {
  it('resizes the grid BEFORE repacking, then repacks every row', () => {
    const { core, handle } = make({ cols: 4, rows: 6 })
    handle.log.length = 0
    handle.rows.length = 0
    core.handleResize(8, 3)
    expect(handle.log[0]).toBe('resize:8x3')
    expect(handle.rows.map((r) => r.row)).toEqual([0, 1, 2])
    // The row buffer follows the new column count — the engine rejects a mismatched length.
    expect(handle.rows[0].buf.length).toBe(8 * CELL_STRIDE)
    expect(handle.rows[0].cells.length).toBe(8 * CELL_STRIDE)
  })

  it('updates dimensions from the new grid size', () => {
    const { core } = make({ cols: 4, rows: 6 })
    core.handleResize(10, 5)
    expect(core.dimensions.device.canvas.width).toBe(16 * 10)
    expect(core.dimensions.device.canvas.height).toBe(34 * 5)
    expect(core.dimensions.css.canvas.width).toBe(80) // round(160 / dpr 2)
    expect(core.dimensions.css.cell.width).toBe(8)
  })
})

describe('GlyphGridRendererAddonCore.dimensions', () => {
  it('is ONE object, mutated in place — xterm Viewport caches it by reference', () => {
    const { core, term } = make({ cols: 4, rows: 6 })
    const dims = core.dimensions
    const cssCell = dims.css.cell
    const deviceChar = dims.device.char

    core.handleResize(10, 5)
    expect(core.dimensions).toBe(dims)
    expect(core.dimensions.css.cell).toBe(cssCell)
    expect(cssCell.width).toBe(8)
    expect(dims.device.canvas.width).toBe(160)

    // A font-size change reaches us as new device metrics + handleCharSizeChanged.
    term.deviceMetrics = (): DeviceMetrics => ({ charW: 20, charH: 40, cellW: 20, cellH: 40 })
    core.handleCharSizeChanged()
    expect(core.dimensions).toBe(dims)
    expect(deviceChar.width).toBe(20)
    expect(dims.device.cell.height).toBe(40)
    expect(cssCell.height).toBe(20) // round(40 * 5 / dpr 2) / 5

    core.handleDevicePixelRatioChange()
    expect(core.dimensions).toBe(dims)
  })

  it('mirrors xterm dimension shape at construction', () => {
    const { core } = make({ cols: 4, rows: 6 })
    expect(core.dimensions).toEqual({
      css: { canvas: { width: 32, height: 102 }, cell: { width: 8, height: 17 } },
      device: {
        canvas: { width: 64, height: 204 },
        cell: { width: 16, height: 34 },
        char: { width: 16, height: 34, left: 0, top: 0 }
      }
    })
  })
})

describe('GlyphGridRendererAddonCore selection', () => {
  it('repacks the union of the OLD and NEW spans, and nothing else', () => {
    const { core, handle } = make({ rows: 8, viewportY: 0 })
    core.handleSelectionChanged([1, 1], [2, 2], false)
    handle.rows.length = 0
    core.handleSelectionChanged([0, 5], [3, 6], false)
    expect([...new Set(handle.rows.map((r) => r.row))].sort((a, b) => a - b)).toEqual([1, 2, 5, 6])
  })

  it('repacks the cleared rows when the selection goes away', () => {
    const { core, handle } = make({ rows: 8 })
    core.handleSelectionChanged([1, 2], [3, 3], false)
    handle.rows.length = 0
    core.handleSelectionChanged(undefined, undefined, false)
    expect(handle.rows.map((r) => r.row)).toEqual([2, 3])
    for (const rec of handle.rows)
      for (let c = 0; c < 4; c++) expect(readCell(rec.cells, c).flags & FLAG_SELECTED).toBe(0)
  })

  it('marks a LINEAR span: first row from startCol, middle rows full width, last row to endCol', () => {
    const { core, handle } = make({ rows: 8, cols: 4 })
    core.handleSelectionChanged([2, 1], [3, 3], false)
    const sel = (row: number): number[] =>
      [0, 1, 2, 3].filter(
        (c) => readCell(handle.rows.find((r) => r.row === row)!.cells, c).flags & FLAG_SELECTED
      )
    expect(sel(1)).toEqual([2, 3])
    expect(sel(2)).toEqual([0, 1, 2, 3])
    expect(sel(3)).toEqual([0, 1, 2])
  })

  it('marks a RECTANGULAR (column-select) span identically on every row in range', () => {
    const { core, handle } = make({ rows: 8, cols: 4 })
    core.handleSelectionChanged([3, 1], [1, 3], true)
    const sel = (row: number): number[] =>
      [0, 1, 2, 3].filter(
        (c) => readCell(handle.rows.find((r) => r.row === row)!.cells, c).flags & FLAG_SELECTED
      )
    // Endpoints arrive in either order; the rectangle spans [min, max).
    expect(sel(1)).toEqual([1, 2])
    expect(sel(2)).toEqual([1, 2])
    expect(sel(3)).toEqual([1, 2])
  })

  it('translates an absolute span through a scrolled viewport', () => {
    const { core, handle } = make({ rows: 4, cols: 4, viewportY: 100, baseY: 100 })
    core.handleSelectionChanged([0, 101], [4, 101], false)
    expect(handle.rows.map((r) => r.row)).toEqual([1])
    expect(readCell(handle.rows[0].cells, 0).flags & FLAG_SELECTED).toBe(FLAG_SELECTED)
  })

  it('ignores a span that lies entirely outside the viewport', () => {
    const { core, handle } = make({ rows: 4, viewportY: 100 })
    handle.rows.length = 0
    core.handleSelectionChanged([0, 10], [4, 12], false)
    expect(handle.rows).toEqual([])
  })
})

describe('GlyphGridRendererAddonCore cursor + focus', () => {
  it('repacks exactly the old and the new cursor row on a move', () => {
    const { core, term, handle } = make({ rows: 8, cursorY: 1 })
    core.renderRows(0, 7)
    handle.rows.length = 0
    term.state.cursorY = 5
    core.handleCursorMove()
    expect(handle.rows.map((r) => r.row).sort((a, b) => a - b)).toEqual([1, 5])
  })

  it('repacks one row when the cursor moves within its row', () => {
    const { core, term, handle } = make({ rows: 8, cursorY: 2, cursorX: 0 })
    handle.rows.length = 0
    term.state.cursorX = 3
    core.handleCursorMove()
    expect(handle.rows.map((r) => r.row)).toEqual([2])
    expect(readCell(handle.rows[0].cells, 3).flags & FLAG_CURSOR).toBe(FLAG_CURSOR)
  })

  it('blur repacks the cursor row without the cursor; focus paints it back', () => {
    const { core, handle } = make({ rows: 8, cursorY: 4, cursorX: 1 })
    handle.rows.length = 0
    core.handleBlur()
    expect(handle.rows.map((r) => r.row)).toEqual([4])
    expect(readCell(handle.rows[0].cells, 1).flags & FLAG_CURSOR).toBe(0)

    handle.rows.length = 0
    core.handleFocus()
    expect(handle.rows.map((r) => r.row)).toEqual([4])
    expect(readCell(handle.rows[0].cells, 1).flags & FLAG_CURSOR).toBe(FLAG_CURSOR)
  })
})

/** THE CURSOR SHAPE — which half of the renderer draws it, and where.
 *
 *  A block is a CELL rewrite (only the cell path can invert the glyph) and every other shape is an
 *  OVERLAY pushed to the grid. So each test here asserts BOTH halves: the shape that should be drawn
 *  as an overlay, and the absence of the one that should not be drawn as cells — a bug that put the
 *  cursor on both paths would paint an opaque quad over the very inversion it just produced. */
describe('GlyphGridRendererAddonCore cursor shape', () => {
  const last = (h: ReturnType<typeof recordingHandle>): GridCursor | null | undefined =>
    h.cursors.at(-1)

  it('pushes NO overlay for a focused block — the cells carry it', () => {
    const { core, handle } = make({ rows: 4, cursorY: 1, cursorX: 2, cursorStyle: { style: 'block' } })
    core.renderRows(0, 3)
    expect(last(handle)).toBe(null)
    expect(readCell(handle.rows.find((r) => r.row === 1)!.cells, 2).flags & FLAG_CURSOR).toBe(
      FLAG_CURSOR
    )
  })

  it('pushes a BAR overlay, and leaves the cell un-inverted', () => {
    const { core, handle } = make({ rows: 4, cursorY: 1, cursorX: 2, cursorStyle: { style: 'bar' } })
    core.renderRows(0, 3)
    expect(last(handle)).toEqual({
      col: 2,
      row: 1,
      shape: 'bar',
      widthCells: 1,
      color: THEME.cursorBg
    })
    expect(readCell(handle.rows.find((r) => r.row === 1)!.cells, 2).flags & FLAG_CURSOR).toBe(0)
  })

  it('pushes an UNDERLINE overlay for that style', () => {
    const { core, handle } = make({ rows: 4, cursorY: 0, cursorX: 1, cursorStyle: { style: 'underline' } })
    core.renderRows(0, 3)
    expect(last(handle)?.shape).toBe('underline')
  })

  it('a BLURRED terminal gets the hollow outline xterm draws by default', () => {
    // The row this task exists for: `outline` is xterm's default `cursorInactiveStyle`, so this is
    // the DEFAULT path, not an exotic setting. Limitation L2 was that it could not be expressed.
    const { core, handle } = make({ rows: 4, cursorY: 2, cursorX: 3, focus: false })
    core.renderRows(0, 3)
    expect(last(handle)).toEqual({
      col: 3,
      row: 2,
      shape: 'outline',
      widthCells: 1,
      color: THEME.cursorBg
    })
    expect(readCell(handle.rows.find((r) => r.row === 2)!.cells, 3).flags & FLAG_CURSOR).toBe(0)
  })

  it('honours an inactive style of none — nothing on either path', () => {
    const { core, handle } = make({
      rows: 4,
      cursorY: 2,
      cursorX: 3,
      focus: false,
      cursorStyle: { inactiveStyle: 'none' }
    })
    core.renderRows(0, 3)
    expect(last(handle)).toBe(null)
    for (const rec of handle.rows)
      for (let c = 0; c < 4; c++) expect(readCell(rec.cells, c).flags & FLAG_CURSOR).toBe(0)
  })

  it('honours an inactive style of BLOCK through the cell path, not the overlay', () => {
    const { core, handle } = make({
      rows: 4,
      cursorY: 2,
      cursorX: 3,
      focus: false,
      cursorStyle: { inactiveStyle: 'block' }
    })
    core.renderRows(0, 3)
    expect(last(handle)).toBe(null)
    expect(readCell(handle.rows.find((r) => r.row === 2)!.cells, 3).flags & FLAG_CURSOR).toBe(
      FLAG_CURSOR
    )
  })

  it('clears the overlay when the app hides the cursor', () => {
    // DECTCEM inside a TUI. A stale overlay would leave a bar sitting in the middle of vim — and
    // unlike a packed row, nothing else ever erases a grid-level value.
    const { core, term, handle } = make({
      rows: 4,
      cursorY: 1,
      cursorX: 1,
      cursorStyle: { style: 'bar' }
    })
    core.renderRows(0, 3)
    expect(last(handle)?.shape).toBe('bar')
    term.state.cursorVisible = false
    core.renderRows(0, 3)
    expect(last(handle)).toBe(null)
  })

  it('reports widthCells 2 when the cursor sits on a WIDE glyph', () => {
    // The overlay's half of L13: a bar on 日 is still one hairline, but an underline or an outline
    // has to span the whole character — which needs the cell's width, not the cursor's column.
    const { core, handle } = make({
      rows: 4,
      cursorY: 0,
      cursorX: 1,
      wideCols: [1],
      cursorStyle: { style: 'underline' }
    })
    core.renderRows(0, 3)
    expect(last(handle)?.widthCells).toBe(2)
  })

  it('clamps the overlay column exactly as the cell path does (deferred wrap)', () => {
    const { core, handle } = make({ cols: 4, rows: 2, cursorX: 4, cursorY: 0, cursorStyle: { style: 'bar' } })
    core.renderRows(0, 1)
    expect(last(handle)?.col).toBe(3)
  })

  it('clears the overlay when the cursor scrolls out of the viewport', () => {
    // The cursor's row is baseY + cursorY - viewportY; scroll back far enough and it is off the top
    // of the viewport. An overlay is a GRID-level value, so nothing else would erase it — a stale
    // one would draw a cursor over whatever text scrolled into that row.
    const { core, term, handle } = make({
      rows: 4,
      baseY: 100,
      viewportY: 100,
      cursorY: 1,
      cursorStyle: { style: 'bar' }
    })
    core.renderRows(0, 3)
    expect(last(handle)?.row).toBe(1)
    term.state.viewportY = 106
    core.renderRows(0, 3)
    expect(last(handle)).toBe(null)
  })

  it('degrades to a block / outline when the shell reports no cursor options at all', () => {
    // An xterm bump that renames the options must cost the user their chosen SHAPE, never their
    // cursor — so the fallbacks are xterm's own defaults.
    const focused = make({ rows: 4, cursorY: 1, cursorX: 1 })
    focused.core.renderRows(0, 3)
    expect(focused.handle.cursors.at(-1)).toBe(null)
    expect(readCell(focused.handle.rows.find((r) => r.row === 1)!.cells, 1).flags & FLAG_CURSOR).toBe(
      FLAG_CURSOR
    )

    const blurred = make({ rows: 4, cursorY: 1, cursorX: 1, focus: false })
    blurred.core.renderRows(0, 3)
    expect(blurred.handle.cursors.at(-1)?.shape).toBe('outline')
  })

  it('follows blur and focus without waiting for a redraw', () => {
    const { core, handle } = make({ rows: 4, cursorY: 1, cursorX: 1, cursorStyle: { style: 'bar' } })
    core.renderRows(0, 3)
    expect(last(handle)?.shape).toBe('bar')
    core.handleBlur()
    expect(last(handle)?.shape).toBe('outline')
    core.handleFocus()
    expect(last(handle)?.shape).toBe('bar')
  })
})

/** BLUR AND THE SELECTION — limitation L3.
 *
 *  xterm paints an unfocused terminal's selection in a quieter colour; this engine's theme lanes
 *  carry no inactive colour, so the feed blends toward the plate. The addon's share is the REPAINT:
 *  blur used to repack the cursor row only, which would have left the selection bright until
 *  something else happened to touch those rows. */
describe('GlyphGridRendererAddonCore blur dims the selection', () => {
  /** THEME.selectionBg blended half-way to THEME.bg — see feed.ts's INACTIVE_SELECTION_BLEND. */
  const DIMMED = packColor(0x20, 0x31, 0x49, 0xff)

  it('repacks the selected rows on blur, in the inactive colour', () => {
    const { core, handle } = make({ rows: 8, cols: 4, cursorY: 0 })
    core.handleSelectionChanged([0, 2], [4, 3], false)
    handle.rows.length = 0
    core.handleBlur()
    expect([...new Set(handle.rows.map((r) => r.row))].sort((a, b) => a - b)).toEqual([0, 2, 3])
    const row2 = handle.rows.find((r) => r.row === 2)!
    expect(readCell(row2.cells, 0).bg).toBe(DIMMED)
    expect(readCell(row2.cells, 0).flags & FLAG_SELECTED).toBe(FLAG_SELECTED)
  })

  it('paints the ACTIVE colour back on focus', () => {
    const { core, handle } = make({ rows: 8, cols: 4, cursorY: 0 })
    core.handleSelectionChanged([0, 2], [4, 3], false)
    core.handleBlur()
    handle.rows.length = 0
    core.handleFocus()
    const row2 = handle.rows.find((r) => r.row === 2)!
    expect(readCell(row2.cells, 0).bg).toBe(THEME.selectionBg)
  })

  it('packs a selection made WHILE blurred in the inactive colour', () => {
    const { core, handle } = make({ rows: 8, cols: 4, focus: false })
    core.handleSelectionChanged([0, 2], [4, 3], false)
    const row2 = handle.rows.find((r) => r.row === 2)!
    expect(readCell(row2.cells, 0).bg).toBe(DIMMED)
  })
})

describe('GlyphGridRendererAddonCore redraw requests', () => {
  it('clear() repacks everything and asks xterm for a full redraw', () => {
    const { core, handle } = make({ rows: 5 })
    const seen: Array<{ start: number; end: number }> = []
    core.onRequestRedraw((e) => seen.push(e))
    handle.rows.length = 0
    core.clear()
    expect(handle.rows.map((r) => r.row)).toEqual([0, 1, 2, 3, 4])
    expect(seen).toEqual([{ start: 0, end: 4 }])
  })

  it('a theme change repacks everything and asks for a full redraw', () => {
    const { core, handle } = make({ rows: 3 })
    const seen: Array<{ start: number; end: number }> = []
    core.onRequestRedraw((e) => seen.push(e))
    handle.rows.length = 0
    core.handleThemeChange()
    expect(handle.rows.map((r) => r.row)).toEqual([0, 1, 2])
    expect(seen).toEqual([{ start: 0, end: 2 }])
  })

  it('a disposed redraw subscription stops receiving', () => {
    const { core } = make()
    const seen: number[] = []
    const sub = core.onRequestRedraw(() => seen.push(1))
    core.clear()
    sub.dispose()
    core.clear()
    expect(seen).toHaveLength(1)
  })
})

/** ATLAS RESETS. The atlas clears its whole page when the colour key space fills, which leaves
 *  every already-packed lane pointing at a slot that now holds someone else's glyph. The addon's
 *  job is to get all its rows repacked — and to do it WITHOUT repacking from inside the reset,
 *  which fires synchronously in the middle of a `glyphFor` call during someone's row pack. */
describe('GlyphGridRendererAddonCore atlas resets', () => {
  it('asks for a DEFERRED full redraw instead of repacking on the spot', () => {
    const { core, handle, atlas } = make({ rows: 5 })
    const seen: Array<{ start: number; end: number }> = []
    core.onRequestRedraw((e) => seen.push(e))
    handle.rows.length = 0
    atlas.fireReset()
    // The repack itself is xterm's to schedule: packing here would run inside whatever pack loop
    // the reset interrupted.
    expect(handle.rows).toEqual([])
    expect(seen).toEqual([{ start: 0, end: 4 }])
  })

  it('a reset fired from INSIDE a row pack does not recurse into the pack loop', () => {
    // The real shape of the event: the page fills on some cell's glyphFor, mid-row. Every
    // requested row must still be packed exactly once, and the repack must arrive as a redraw
    // request rather than as a nested pack.
    let fired = false
    const atlas = recordingAtlas({
      onGlyphFor: (fire) => {
        if (fired) return
        fired = true
        fire()
      }
    })
    const { core, handle } = make({ rows: 4, atlas })
    const seen: Array<{ start: number; end: number }> = []
    core.onRequestRedraw((e) => seen.push(e))
    core.renderRows(0, 2)
    expect(handle.rows.map((r) => r.row)).toEqual([0, 1, 2])
    expect(seen).toEqual([{ start: 0, end: 3 }])
  })

  it('unsubscribes from the atlas on dispose — a torn-down terminal owes it no repack', () => {
    const { core, atlas } = make()
    const seen: number[] = []
    core.onRequestRedraw(() => seen.push(1))
    expect(atlas.subCount()).toBe(1)
    core.dispose()
    expect(atlas.subCount()).toBe(0)
    atlas.fireReset()
    expect(seen).toEqual([])
  })
})

/** DECORATIONS. The terminal's decoration service colours cells (a ⌘F hit is one), and it changes
 *  from OUTSIDE the render loop — the search addon registers a decoration per match while nothing
 *  is being packed. The addon's job is to hand the reader through to the feed keyed by the right
 *  row, and to get every row repacked when the set changes. */
describe('GlyphGridRendererAddonCore decorations', () => {
  const DECO_BG = packColor(0xff, 0xc8, 0x00, 0xff)

  it('feeds decorations keyed by the ABSOLUTE buffer row, not the viewport row', () => {
    // Viewport starts at absolute 100, so viewport row 1 is absolute 101 — the row the decoration
    // marker is on. Keyed by the viewport row instead, the highlight would slide with every scroll.
    const deco = fakeDecorations([{ col: 2, row: 101, bg: DECO_BG }])
    const { core, handle } = make({ rows: 4, cols: 4, viewportY: 100, baseY: 100, decorations: deco })
    core.renderRows(0, 3)
    const row1 = handle.rows.find((r) => r.row === 1)!
    expect(readCell(row1.cells, 2).bg).toBe(DECO_BG)
    const row0 = handle.rows.find((r) => r.row === 0)!
    expect(readCell(row0.cells, 2).bg).toBe(THEME.bg)
  })

  it('asks for a DEFERRED full redraw when a decoration is registered or removed', () => {
    // Same mechanism as an atlas reset: a decoration changes cell COLOURS, so every row has to be
    // re-fed — but the pack itself is xterm's to schedule, never a repack from inside this event.
    const deco = fakeDecorations()
    const { core, handle } = make({ rows: 5, decorations: deco })
    const seen: Array<{ start: number; end: number }> = []
    core.onRequestRedraw((e) => seen.push(e))
    handle.rows.length = 0

    deco.fireRegistered()
    expect(handle.rows).toEqual([])
    expect(seen).toEqual([{ start: 0, end: 4 }])

    deco.fireRemoved()
    expect(handle.rows).toEqual([])
    expect(seen).toEqual([
      { start: 0, end: 4 },
      { start: 0, end: 4 }
    ])
  })

  it('unsubscribes from BOTH decoration events on dispose', () => {
    const deco = fakeDecorations()
    const { core } = make({ rows: 3, decorations: deco })
    const seen: number[] = []
    core.onRequestRedraw(() => seen.push(1))
    expect(deco.subCount()).toBe(2)
    core.dispose()
    expect(deco.subCount()).toBe(0)
    deco.fireRegistered()
    deco.fireRemoved()
    expect(seen).toEqual([])
  })

  it('constructs and packs normally when the terminal has no decoration service at all', () => {
    // The degradation contract: an xterm build without `_decorationService` must render, minus the
    // highlights — never refuse the attach.
    const { core, handle } = make({ rows: 2, cols: 2 })
    core.renderRows(0, 1)
    expect(handle.rows.map((r) => r.row)).toEqual([0, 1])
  })
})

describe('GlyphGridRendererAddonCore.dispose', () => {
  it('makes every further call inert — a torn-down terminal must never touch the grid', () => {
    const { core, handle } = make({ rows: 6 })
    const seen: number[] = []
    core.onRequestRedraw(() => seen.push(1))
    core.dispose()
    handle.log.length = 0
    handle.rows.length = 0
    core.renderRows(0, 5)
    core.clear()
    core.handleThemeChange()
    core.handleResize(9, 9)
    core.handleSelectionChanged([0, 0], [2, 2], false)
    core.handleCursorMove()
    core.handleBlur()
    core.handleFocus()
    core.handleCharSizeChanged()
    core.handleDevicePixelRatioChange()
    expect(handle.log).toEqual([])
    expect(handle.rows).toEqual([])
    expect(seen).toEqual([])
  })

  it('does NOT dispose the grid handle — the node that registered it owns its lifetime', () => {
    const { core, handle } = make()
    core.dispose()
    expect(handle.log).not.toContain('dispose')
  })
})
