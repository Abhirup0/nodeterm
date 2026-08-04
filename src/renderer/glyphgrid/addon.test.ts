import { describe, expect, it } from 'vitest'
// TEST-ONLY cross-layer import, and the only one in this directory: the blink is a CONTRACT between
// the clock (which owns the timing and the damage routing) and this addon (which owns applying a
// phase), and the trap it exists to avoid lives exactly in the seam between them — see the last
// describe. `src/renderer/glyphgrid/` itself still imports nothing.
import { createCursorBlinkClock, type CursorBlinkClock } from '../canvas/SharedGlyphLayer'
import type { GlyphAtlas } from './atlas'
import { CELL_STRIDE, FLAG_CURSOR, FLAG_SELECTED, packColor, readCell } from './cells'
import type { GridCursor } from './cursor'
import type { GridHandle } from './engine'
import {
  GlyphGridRendererAddonCore,
  type CursorBlinkPhaseTarget,
  type CursorBlinkSeam,
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

/** The canvas blink clock's end of the seam, as the attach shell implements it: `release` is
 *  IDENTITY-GUARDED, because browsers do not promise that the blurred terminal's blur reaches us
 *  before the newly focused one's focus. Modelling that here is what makes the handover assertion
 *  mean anything — an unguarded fake would pass against an unguarded shell.
 *
 *  `onRelease` stands in for the clock's own restoring `setPhase(true)`, which is the behaviour
 *  `dispose` has to leave room for. */
function fakeBlinkSeam(o: { onRelease?: (t: CursorBlinkPhaseTarget) => void } = {}): {
  seam: CursorBlinkSeam
  target(): CursorBlinkPhaseTarget | null
  claims: CursorBlinkPhaseTarget[]
  releases: CursorBlinkPhaseTarget[]
} {
  let current: CursorBlinkPhaseTarget | null = null
  const claims: CursorBlinkPhaseTarget[] = []
  const releases: CursorBlinkPhaseTarget[] = []
  return {
    seam: {
      claim(t) {
        claims.push(t)
        current = t
      },
      release(t) {
        releases.push(t)
        if (current !== t) return
        current = null
        o.onRelease?.(t)
      }
    },
    target: () => current,
    claims,
    releases
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
  /** The blink seam. ABSENT in every test that does not name it — a build with no shared layer
   *  hands the addon exactly this, and the cursor simply never blinks. */
  blink?: CursorBlinkSeam
}

type FakeTermState = Required<
  Omit<FakeTermOpts, 'decorations' | 'cursorStyle' | 'wideCols' | 'blink'>
>

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
    // Absent unless a test asks for it, like the decorations below.
    blink: o.blink,
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

  it('repacks the cursor row when a style flip changes BLOCK-ness under a pack that misses it', () => {
    // The two halves run on different schedules: the overlay is re-pushed by EVERY pack, the cell
    // half only by one that covers the cursor row. Flip `cursorInactiveStyle` from block to outline
    // on a BLURRED terminal and then do something that packs other rows — a drag-select — and the
    // outline would be drawn around a cell still holding the inverted block. Self-healing
    // eventually, but checklist 2.12 walks a tester straight into it.
    const style = { style: 'block', inactiveStyle: 'block' }
    const { core, handle } = make({
      rows: 8,
      cols: 4,
      cursorY: 0,
      cursorX: 1,
      focus: false,
      cursorStyle: style
    })
    core.renderRows(0, 7)
    expect(readCell(handle.rows.find((r) => r.row === 0)!.cells, 1).flags & FLAG_CURSOR).toBe(
      FLAG_CURSOR
    )
    handle.rows.length = 0
    style.inactiveStyle = 'outline'
    core.renderRows(4, 5)
    expect(handle.rows.map((r) => r.row)).toContain(0)
    expect(readCell(handle.rows.find((r) => r.row === 0)!.cells, 1).flags & FLAG_CURSOR).toBe(0)
    expect(last(handle)?.shape).toBe('outline')
  })

  it('repacks it the other way too — the overlay goes at once, so the block must arrive at once', () => {
    const style = { style: 'block', inactiveStyle: 'outline' }
    const { core, handle } = make({
      rows: 8,
      cols: 4,
      cursorY: 0,
      cursorX: 1,
      focus: false,
      cursorStyle: style
    })
    core.renderRows(0, 7)
    expect(last(handle)?.shape).toBe('outline')
    handle.rows.length = 0
    style.inactiveStyle = 'block'
    core.renderRows(4, 5)
    expect(last(handle)).toBe(null)
    // Without the repair this terminal would show NO cursor at all until its cursor row happened
    // to be packed by something else.
    expect(readCell(handle.rows.find((r) => r.row === 0)!.cells, 1).flags & FLAG_CURSOR).toBe(
      FLAG_CURSOR
    )
  })

  it('repairs nothing when the pack already covers the cursor row', () => {
    // Both halves of the cost/termination argument: the repair re-enters packRows, so it must fire
    // only when the cursor row is genuinely stale AND is a row a pack can reach.
    const style = { style: 'block', inactiveStyle: 'block' }
    const { core, handle } = make({
      rows: 4,
      cols: 4,
      cursorY: 1,
      cursorX: 1,
      focus: false,
      cursorStyle: style
    })
    core.renderRows(0, 3)
    handle.rows.length = 0
    style.inactiveStyle = 'outline'
    core.renderRows(1, 1) // the cursor row itself — repainted once, not twice
    expect(handle.rows.map((r) => r.row)).toEqual([1])

    handle.rows.length = 0
    style.inactiveStyle = 'block'
    core.renderRows(3, 3) // flips back, and now the cursor row is NOT in range
    expect(handle.rows.map((r) => r.row).sort((a, b) => a - b)).toEqual([1, 3])
  })
})

/** THE BLINK PHASE — the producer half of the canvas's cursor-blink clock.
 *
 *  The clock (`canvas/SharedGlyphLayer.tsx`) owns the timing; the addon is the only thing that can
 *  APPLY a phase, because a block cursor is a CELL rewrite and every other shape is an OVERLAY and
 *  only this class holds both. So every test here asserts BOTH halves: a phase that hid one and not
 *  the other would leave an inverted cell under a cleared overlay, or a bar hanging beside a cursor
 *  that is supposed to be gone. */
describe('GlyphGridRendererAddonCore.setCursorBlinkPhase', () => {
  const lastCursor = (h: ReturnType<typeof recordingHandle>): GridCursor | null | undefined =>
    h.cursors.at(-1)
  /** The cursor flag on the NEWEST pack of a row — the older packs are still in the log, and a
   *  blink is precisely a sequence of packs of the same row. */
  const cursorFlag = (
    h: ReturnType<typeof recordingHandle>,
    row: number,
    col: number
  ): number => {
    const rec = [...h.rows].reverse().find((r) => r.row === row)
    if (!rec) throw new Error(`row ${row} was never packed`)
    return readCell(rec.cells, col).flags & FLAG_CURSOR
  }

  it('hides BOTH halves of a block cursor for the hidden phase, and brings both back', () => {
    const { core, handle } = make({ rows: 4, cols: 4, cursorY: 1, cursorX: 2 })
    core.renderRows(0, 3)
    expect(cursorFlag(handle, 1, 2)).toBe(FLAG_CURSOR)
    // A block never uses the overlay — the cells carry it, which is why the overlay alone could
    // never have implemented this.
    expect(lastCursor(handle)).toBe(null)

    core.setCursorBlinkPhase(false)
    expect(cursorFlag(handle, 1, 2)).toBe(0)
    expect(lastCursor(handle)).toBe(null)

    core.setCursorBlinkPhase(true)
    expect(cursorFlag(handle, 1, 2)).toBe(FLAG_CURSOR)
  })

  it('hides the OVERLAY half too — a bar cursor blinks on the same phase', () => {
    const { core, handle } = make({
      rows: 4,
      cols: 4,
      cursorY: 1,
      cursorX: 2,
      cursorStyle: { style: 'bar' }
    })
    core.renderRows(0, 3)
    expect(lastCursor(handle)?.shape).toBe('bar')

    core.setCursorBlinkPhase(false)
    expect(lastCursor(handle)).toBe(null)
    expect(cursorFlag(handle, 1, 2)).toBe(0)

    core.setCursorBlinkPhase(true)
    expect(lastCursor(handle)?.shape).toBe('bar')
  })

  it('repacks the cursor row SYNCHRONOUSLY, and asks for NO redraw', () => {
    // THE contract. The clock brackets this call to route the damage it produces through the frame
    // loop's one-shot `pulse()`; a repack handed to `onRequestRedraw` (as an atlas reset or a
    // decoration change is) would land outside that bracket, take `wake()`, and re-arm the 30-frame
    // idle streak twice a second.
    const { core, handle } = make({ rows: 4, cols: 4, cursorY: 2, cursorX: 0 })
    const redraws: Array<{ start: number; end: number }> = []
    core.onRequestRedraw((e) => redraws.push(e))
    handle.rows.length = 0

    core.setCursorBlinkPhase(false)

    expect(handle.rows.map((r) => r.row)).toEqual([2])
    expect(redraws).toEqual([])
  })

  it('is change-gated — the same phase twice costs one pack', () => {
    const { core, handle } = make({ rows: 4, cols: 4, cursorY: 2, cursorX: 0 })
    handle.rows.length = 0
    core.setCursorBlinkPhase(false)
    core.setCursorBlinkPhase(false)
    expect(handle.rows.map((r) => r.row)).toEqual([2])
  })

  it('is inert after dispose — a clock tick racing a teardown must not touch the grid', () => {
    const { core, handle } = make({ rows: 4, cols: 4, cursorY: 2, cursorX: 0 })
    core.dispose()
    handle.log.length = 0
    core.setCursorBlinkPhase(false)
    expect(handle.log).toEqual([])
  })

  it('a pack that misses the cursor row during a hidden phase neither repairs nor resurrects it', () => {
    // A hidden phase is the same "no cursor row in this pass" case DECTCEM already produces, so
    // `settleCursorCells` takes neither branch: no repair repack, and certainly no block painted
    // back onto a row the blink just cleared.
    const { core, handle } = make({ rows: 8, cols: 4, cursorY: 0, cursorX: 1 })
    core.renderRows(0, 7)
    core.setCursorBlinkPhase(false)
    handle.rows.length = 0
    core.renderRows(4, 5)
    expect(handle.rows.map((r) => r.row)).toEqual([4, 5])
  })

  it('the block-ness repair still fires once the phase returns', () => {
    // Constraint: hiding the cursor must not corrupt `cellCursorBlock`. Flip block-ness WHILE the
    // cursor is hidden and pack rows that miss it — the bookkeeping the repair reads is stale by
    // construction — then show the cursor again and the row must come back as an outline: cells
    // un-inverted, overlay pushed.
    const style = { style: 'block', inactiveStyle: 'block' }
    const { core, handle } = make({
      rows: 8,
      cols: 4,
      cursorY: 0,
      cursorX: 1,
      focus: false,
      cursorStyle: style
    })
    core.renderRows(0, 7)
    expect(cursorFlag(handle, 0, 1)).toBe(FLAG_CURSOR)

    core.setCursorBlinkPhase(false)
    style.inactiveStyle = 'outline'
    core.renderRows(4, 5)
    handle.rows.length = 0

    core.setCursorBlinkPhase(true)
    expect(handle.rows.map((r) => r.row)).toEqual([0])
    expect(cursorFlag(handle, 0, 1)).toBe(0)
    expect(lastCursor(handle)?.shape).toBe('outline')
  })

  it('a cursor the APP has hidden stays hidden through a shown phase', () => {
    // DECTCEM and the blink are independent reasons not to draw; neither may override the other.
    const { core, handle } = make({
      rows: 4,
      cols: 4,
      cursorY: 1,
      cursorX: 1,
      cursorVisible: false
    })
    core.renderRows(0, 3)
    core.setCursorBlinkPhase(false)
    core.setCursorBlinkPhase(true)
    expect(cursorFlag(handle, 1, 1)).toBe(0)
    expect(lastCursor(handle)).toBe(null)
  })
})

/** WHICH terminal blinks — the focus edge the clock's only gate is built on. */
describe('GlyphGridRendererAddonCore blink target', () => {
  it('claims the blink at construction when the terminal already has focus', () => {
    // A mode switch or a remount attaches to a terminal the user is already typing in; a clock
    // that only learned about focus on the NEXT focus event would leave that cursor static.
    const blink = fakeBlinkSeam()
    const { core } = make({ blink: blink.seam, focus: true })
    expect(blink.target()).not.toBe(null)
    core.dispose()
  })

  it('claims nothing while the terminal is blurred', () => {
    const blink = fakeBlinkSeam()
    make({ blink: blink.seam, focus: false })
    expect(blink.claims).toEqual([])
    expect(blink.target()).toBe(null)
  })

  it('claims on focus, releases on blur, and hands over the SAME object every time', () => {
    // Identity is the contract: the clock is change-gated on it (`next !== current`), so a fresh
    // object per focus event would restart the blink period on every notification.
    const blink = fakeBlinkSeam()
    const { core } = make({ blink: blink.seam, focus: false })
    core.handleFocus()
    const first = blink.target()
    expect(first).not.toBe(null)
    core.handleBlur()
    expect(blink.target()).toBe(null)
    core.handleFocus()
    expect(blink.target()).toBe(first)
  })

  it('a LATE blur cannot steal the blink from the terminal that just took focus', () => {
    // Browsers do not promise the blur of the old terminal reaches us before the focus of the new
    // one. An unconditional clear on blur would stop the cursor of the terminal the user just
    // clicked into — which is the only terminal that is supposed to be blinking.
    const blink = fakeBlinkSeam()
    const a = make({ blink: blink.seam, focus: true })
    const b = make({ blink: blink.seam, focus: false })
    b.core.handleFocus()
    const bTarget = blink.target()
    a.core.handleBlur()
    expect(blink.target()).toBe(bTarget)
  })

  it('releases BEFORE it goes inert, so the clock can hand the cursor back shown', () => {
    // The clock restores the phase from inside its release path. If dispose had already flipped the
    // addon inert, that restore would be a silent no-op and the last packed row would keep the
    // cursor the blink happened to be hiding — an invisible cursor on a node swapped back to the
    // DOM renderer.
    const blink = fakeBlinkSeam({ onRelease: (t) => t.setPhase(true) })
    const { core, handle } = make({ rows: 4, cols: 4, cursorY: 1, cursorX: 2, blink: blink.seam })
    core.renderRows(0, 3)
    core.setCursorBlinkPhase(false)
    handle.rows.length = 0

    core.dispose()

    const rec = [...handle.rows].reverse().find((r) => r.row === 1)
    expect(rec).toBeDefined()
    expect(readCell(rec!.cells, 2).flags & FLAG_CURSOR).toBe(FLAG_CURSOR)
    expect(blink.target()).toBe(null)
  })

  it('constructs and packs normally when the shell offers no blink seam at all', () => {
    // The degrade: no shared layer, no clock, no blink — Phase 1b's behaviour, not a broken addon.
    const { core, handle } = make({ rows: 4, cols: 4, cursorY: 1, cursorX: 2 })
    core.renderRows(0, 3)
    core.handleFocus()
    core.handleBlur()
    core.dispose()
    expect(handle.rows.length).toBeGreaterThan(0)
  })
})

/**
 * THE PARK, END TO END — the one constraint this whole design exists to satisfy.
 *
 * The unit tests above prove the addon repacks on the caller's stack; the clock's own tests prove it
 * routes its bracketed damage to `pulse()`. Neither alone proves the FEATURE parks, because the trap
 * lives exactly in the seam between them: an addon that repacked one tick later would satisfy both
 * and still put an idle canvas back at the display's refresh rate, thirty frames every 600 ms.
 *
 * So this wires the REAL addon to the REAL clock through a handle that reports damage the way the
 * engine does — edge-triggered on the clean→dirty transition, cleared by the frame the loop draws.
 */
describe('the blink phase through the real clock', () => {
  function wired(): {
    core: GlyphGridRendererAddonCore
    handle: ReturnType<typeof recordingHandle>
    loop: { wake: number; pulse: number }
    running(): boolean
    tick(): void
    frame(): void
  } {
    const handle = recordingHandle()
    let clock: CursorBlinkClock | null = null
    const loop = { wake: 0, pulse: 0 }
    // The engine's `markDirty` notifies on the clean→dirty EDGE only, and the FRAME clears the flag
    // — neither `wake()` nor `pulse()` draws inline, they schedule. Modelling that (rather than one
    // notification per write) is what makes the counts below mean "frames scheduled", which is the
    // number the park is about.
    let dirty = false
    const damage = (): void => {
      if (dirty) return
      dirty = true
      clock?.routeDamage()
    }
    const damaging: GridHandle = {
      ...handle,
      updateRow(row, cells) {
        handle.updateRow(row, cells)
        damage()
      },
      setCursor(cursor) {
        handle.setCursor(cursor)
        damage()
      }
    }

    let current: CursorBlinkPhaseTarget | null = null
    // The attach shell's seam, verbatim in behaviour: claim publishes, release is identity-guarded,
    // and either change re-syncs the clock (the real one does it through the layer's subscription).
    const seam: CursorBlinkSeam = {
      claim(t) {
        current = t
        clock?.sync()
      },
      release(t) {
        if (current !== t) return
        current = null
        clock?.sync()
      }
    }

    let fire: (() => void) | null = null
    clock = createCursorBlinkClock({
      enabled: () => true,
      covered: () => false,
      target: () => current,
      loop: () => ({
        wake: () => {
          loop.wake++
        },
        pulse: () => {
          loop.pulse++
        }
      }),
      setInterval: (cb) => {
        fire = cb
        return 1
      },
      clearInterval: () => {
        fire = null
      }
    })

    const term = fakeTerm({ rows: 4, cols: 4, cursorY: 1, cursorX: 2, focus: true, blink: seam })
    const core = new GlyphGridRendererAddonCore(term, damaging, recordingAtlas())
    return {
      core,
      handle,
      loop,
      running: () => fire !== null,
      tick: () => fire?.(),
      frame: () => {
        dirty = false
      }
    }
  }

  it('a phase flip costs ONE pulse and never a wake — the idle park survives the blink', () => {
    const h = wired()
    // The addon claimed the blink at construction, so the clock is already ticking.
    expect(h.running()).toBe(true)
    for (let i = 0; i < 3; i++) {
      h.tick()
      // The frame the pulse scheduled draws and clears the engine's dirty flag, 600 ms before the
      // next phase — which is what lets the next flip notify at all.
      h.frame()
    }
    expect(h.loop.pulse).toBe(3)
    expect(h.loop.wake).toBe(0)
  })

  it('ordinary damage from the SAME addon still takes wake()', () => {
    // The other half of the routing: only the clock's own bracketed repaint is a pulse. A terminal
    // writing rows is likely to be followed by more, and a pulse per write would put a scheduling
    // hop in front of every character.
    const h = wired()
    h.core.renderRows(0, 3)
    expect(h.loop.wake).toBe(1)
    expect(h.loop.pulse).toBe(0)
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
