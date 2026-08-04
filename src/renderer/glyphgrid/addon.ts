/** The xterm-facing brain of the glyphgrid renderer: xterm's renderer callbacks in, packed grid
 *  rows out.
 *
 *  Like the rest of this directory it imports NOTHING from xterm. Everything the terminal knows
 *  arrives through `TermInternals`, a hand-written narrowing of the handful of xterm internals we
 *  read, built by `src/renderer/terminal/glyphgrid-attach.ts`. That split is the point: xterm's
 *  private surface is the part of that library most likely to move under us, and keeping it behind
 *  one injected interface means a bump breaks ONE thin shell instead of the renderer, and lets the
 *  whole render path be unit-tested without a DOM, a canvas or a terminal. */

import type { GlyphAtlas, GlyphAtlasSubscription } from './atlas'
import { CELL_STRIDE } from './cells'
import type { GridHandle } from './engine'
import { packViewportRow, type CellView, type ThemeLanes } from './feed'

/** Cell/char metrics in DEVICE pixels, already carrying xterm's own rounding (charSize × dpr,
 *  ceil on char height, letterSpacing, lineHeight). The shell computes them exactly the way
 *  xterm's own renderers do, because `dimensions.css.cell` derived from them is what xterm maps
 *  MOUSE COORDINATES through — a rounding that differs by a fraction of a pixel per row puts the
 *  selection on the wrong line at the bottom of a tall terminal. */
export interface DeviceMetrics {
  charW: number
  charH: number
  cellW: number
  cellH: number
}

/** What the addon needs from a live terminal. Kept minimal so the addon is testable with fakes and
 *  survives xterm minor bumps. */
export interface TermInternals {
  cols(): number
  rows(): number
  /** buffer.ydisp — the absolute row the viewport's top line shows. */
  viewportY(): number
  /** buffer.ybase — the absolute row the cursor's row index is relative to. */
  baseY(): number
  cursorX(): number
  /** base-relative (buffer.y); viewport row = baseY + cursorY - viewportY */
  cursorY(): number
  /** xterm's `isCursorInitialized && !isCursorHidden`. A TUI that hides the cursor (DECTCEM)
   *  must not leave a phantom block sitting in the middle of the screen. */
  cursorVisible(): boolean
  readCell(absoluteRow: number, col: number, into: CellView): CellView | undefined
  makeWorkCell(): CellView
  deviceMetrics(): DeviceMetrics
  dpr(): number
  theme(): ThemeLanes
  /** Read ONCE, at construction — see `focused`. */
  hasFocus(): boolean
}

/** The exact shape of xterm's `IRenderer.dimensions`. RenderService reads it straight off the
 *  renderer object (`get dimensions()`), so it must exist from the first tick after setRenderer. */
export interface RendererDims {
  css: { canvas: { width: number; height: number }; cell: { width: number; height: number } }
  device: {
    canvas: { width: number; height: number }
    cell: { width: number; height: number }
    char: { width: number; height: number; left: number; top: number }
  }
}

type SelPoint = readonly [number, number]

/** Inclusive viewport-row range, or null for "nothing to do". */
type RowRange = readonly [number, number] | null

/** Order two absolute buffer points. xterm's selection service already hands them over ordered,
 *  but a renderer that assumed so and was wrong would silently draw NOTHING (every row would fall
 *  outside the range) — a cheap comparison buys immunity. */
function orderPoints(a: SelPoint, b: SelPoint): [SelPoint, SelPoint] {
  if (a[1] > b[1] || (a[1] === b[1] && a[0] > b[0])) return [b, a]
  return [a, b]
}

export class GlyphGridRendererAddonCore {
  /** Allocated ONCE and mutated in place on resize / char-size / dpr change — never reassigned.
   *
   *  xterm's `Viewport` caches this object BY REFERENCE (it keeps whatever `onDimensionsChange`
   *  handed it) and re-reads only on the next dimensions event — which fires BEFORE our
   *  `handleResize` runs, since RenderService registered its own listeners first. Hand out a FRESH
   *  object and the Viewport goes on computing row height and scroll-area geometry from the
   *  previous font size, with its `syncScrollArea` guard comparing stale to stale so it never
   *  notices. Identity is the contract here, not an optimization. */
  readonly dimensions: RendererDims = {
    css: { canvas: { width: 0, height: 0 }, cell: { width: 0, height: 0 } },
    device: {
      canvas: { width: 0, height: 0 },
      cell: { width: 0, height: 0 },
      char: { width: 0, height: 0, left: 0, top: 0 }
    }
  }

  private cols: number
  private rows: number
  private disposed = false
  /** ONE row buffer for every row of every frame — `GridHandle.updateRow` copies, so reusing it is
   *  safe, and packing a 200-row canvas of terminals must not allocate. Replaced only when the
   *  column count changes (the engine rejects a row of the wrong length). */
  private rowBuf: Uint32Array
  private readonly workCell: CellView
  private readonly redrawListeners = new Set<(e: { start: number; end: number }) => void>()

  /** Absolute buffer selection, normalized so `selTop` is never after `selBottom`. */
  private selTop: SelPoint | undefined
  private selBottom: SelPoint | undefined
  private columnSelect = false

  /** Focus is OURS to track, not a live read of the terminal: xterm calls handleBlur/handleFocus
   *  from its own focus events, and whether the browser-service flag has already flipped by then
   *  is an ordering detail we would be betting the cursor's correctness on. Seeded once. */
  private focused: boolean
  /** Viewport row the cursor was on at the last cursor-move — the row a move has to REPAINT to
   *  erase the old block. Geometric (not focus-gated), so blur/focus and moves stay independent. */
  private lastCursorRow: number

  /** Mutable because `readCellBound` closes over it: one closure for the lifetime of the addon
   *  instead of one per packed row. */
  private absRow = 0
  private readonly readCellBound = (col: number, into: CellView): CellView | undefined =>
    this.internals.readCell(this.absRow, col, into)

  /** Live for the addon's whole life; disposed in `dispose()`. The atlas is SHARED by every
   *  terminal on the canvas, so a subscription left behind holds a torn-down addon alive and asks
   *  it to repack rows into a grid its node has already dropped. */
  private readonly atlasResetSub: GlyphAtlasSubscription

  constructor(
    private readonly internals: TermInternals,
    private readonly handle: GridHandle,
    private readonly atlas: Pick<GlyphAtlas, 'glyphFor' | 'onReset'>
  ) {
    this.cols = internals.cols()
    this.rows = internals.rows()
    this.rowBuf = new Uint32Array(Math.max(0, this.cols) * CELL_STRIDE)
    this.workCell = internals.makeWorkCell()
    this.focused = internals.hasFocus()
    this.lastCursorRow = this.cursorViewportRow()
    this.updateDims()
    // LAST, so nothing above can throw after the subscription exists: the shell catches a failing
    // construction and restores the DOM renderer, and a subscription made before that throw would
    // never be disposed by anyone.
    this.atlasResetSub = this.atlas.onReset(() => this.handleAtlasReset())
  }

  // ---------------------------------------------------------------- xterm renderer surface
  //
  // Every member RenderService calls, and nothing else. The one deliberate omission is the
  // OPTIONAL `clearTextureAtlas`: the atlas is SHARED by every terminal on the canvas, so one
  // terminal must not be able to wipe it — a font change tears the whole shared context down and
  // re-registers each node instead. RenderService calls it as `?.()`, so leaving it off is the
  // supported way to decline.

  renderRows(start: number, end: number): void {
    this.packRows(start, end)
  }

  /** xterm calls this when the active buffer switches (alt screen in/out). The grid's rows are
   *  simply repacked from whatever buffer is now active; the redraw request is what gets the
   *  ranges xterm considers dirty replayed on top. */
  clear(): void {
    this.repackAll()
  }

  handleResize(cols: number, rows: number): void {
    if (this.disposed) return
    this.cols = cols
    this.rows = rows
    if (this.rowBuf.length !== cols * CELL_STRIDE) this.rowBuf = new Uint32Array(cols * CELL_STRIDE)
    // The grid must be the new size BEFORE the first row of the new frame reaches it — an
    // updateRow of the new width against the old grid is rejected outright.
    this.handle.resize(cols, rows)
    this.updateDims()
    this.packRows(0, rows - 1)
  }

  /** Cell metrics changed (font size, letter spacing). Only the DIMENSIONS are ours to fix: the
   *  grid's own cell size is fixed at registration and a change tears the shared context down and
   *  re-registers every node (see the shared layer), so there is nothing to repack here. */
  handleCharSizeChanged(): void {
    if (this.disposed) return
    this.updateDims()
  }

  handleDevicePixelRatioChange(): void {
    if (this.disposed) return
    this.updateDims()
  }

  /** Absolute buffer coords, straight from xterm's selection service.
   *
   *  Only the rows the selection ENTERED or LEFT are repacked — the union of the old and the new
   *  span. xterm's own DOM renderer repaints all `rows` here, which on this canvas would mean
   *  repacking every row of every terminal on every drag tick. */
  handleSelectionChanged(
    start: SelPoint | undefined,
    end: SelPoint | undefined,
    columnSelectMode: boolean
  ): void {
    if (this.disposed) return
    const before = this.selectionRowRange()
    if (start && end) {
      const [top, bottom] = orderPoints(start, end)
      this.selTop = top
      this.selBottom = bottom
    } else {
      this.selTop = undefined
      this.selBottom = undefined
    }
    this.columnSelect = columnSelectMode
    const after = this.selectionRowRange()
    for (const [from, to] of mergeRanges(before, after)) this.packRows(from, to)
  }

  handleCursorMove(): void {
    if (this.disposed) return
    const next = this.cursorViewportRow()
    const prev = this.lastCursorRow
    this.lastCursorRow = next
    this.packRows(next, next)
    if (prev !== next) this.packRows(prev, prev)
  }

  handleBlur(): void {
    if (this.disposed) return
    this.focused = false
    this.packCursorRow()
  }

  handleFocus(): void {
    if (this.disposed) return
    this.focused = true
    this.packCursorRow()
  }

  /** Not part of xterm's renderer surface — the shell calls it from `_themeService.onChangeColors`.
   *  Every packed lane is a resolved color, so a theme change invalidates the whole grid. */
  handleThemeChange(): void {
    this.repackAll()
  }

  onRequestRedraw(cb: (e: { start: number; end: number }) => void): { dispose(): void } {
    this.redrawListeners.add(cb)
    return {
      dispose: (): void => {
        this.redrawListeners.delete(cb)
      }
    }
  }

  /** Called by xterm when the renderer is replaced (RenderService holds it in a MutableDisposable),
   *  and by the shell's own teardown. Everything after this is a silent no-op: a terminal being
   *  torn down mid-frame is a teardown race, not a bug, and it must never write into a grid whose
   *  owner has already dropped it.
   *
   *  The grid HANDLE is deliberately not disposed — the node that registered it owns its lifetime
   *  (it outlives a renderer swap back to DOM). */
  dispose(): void {
    this.disposed = true
    this.redrawListeners.clear()
    this.atlasResetSub.dispose()
  }

  // ---------------------------------------------------------------- internals

  /**
   * The shared atlas cleared its page (its colour key space filled), so EVERY lane this addon has
   * ever packed now names a slot holding some other cell's glyph. All rows have to be repacked.
   *
   * DEFERRED, NOT IMMEDIATE, and that is the whole design of this method. A reset fires
   * synchronously from inside a `glyphFor` call — i.e. from the middle of a `packRows` loop, ours
   * or another terminal's. Repacking here would re-enter that loop, and the atlas's own guard would
   * then hand the re-entrant requests the BLANK slot to stop it recursing, so the repack would
   * produce exactly the empty cells it exists to prevent. Instead we ask xterm for a full redraw
   * through the same `onRequestRedraw` mechanism `clear()` and a theme change use: RenderService
   * marks the rows dirty and packs them from its own debounced render pass, outside anybody's loop.
   *
   * WHY THE ENGINE'S UPLOAD ORDERING SURVIVES THIS. The engine uploads the atlas before it uploads
   * rows and both before it draws, and a reset preserves that: it marks the atlas dirty, so the
   * next frame re-uploads the cleared-and-refilled page BEFORE any row of it is drawn. Within that
   * frame, the row whose pack triggered the reset carries fresh slots (its remaining cells
   * allocated into the new page); OTHER rows may still name slots that meant something else in the
   * old page, and they are repainted one frame late — the frame this redraw request schedules. A
   * single frame of possibly-stale glyphs on rows nobody has touched, self-healing, is the accepted
   * cost of resets being rare; the alternative is a synchronous repack inside a pack loop, which is
   * a correctness problem rather than a cosmetic one.
   *
   * Bounded by nothing here on purpose: a page too small for the canvas would reset again on the
   * repack, request another redraw, and settle into a repaint per frame. That is the LRU escalation
   * Phase 2 names, and it needs to be VISIBLE (the atlas logs `resetCount`) rather than smoothed
   * over by a rate limit in the one place that knows the rows are wrong.
   */
  private handleAtlasReset(): void {
    if (this.disposed || this.rows <= 0) return
    this.emitRedraw(0, this.rows - 1)
  }

  private repackAll(): void {
    if (this.disposed) return
    this.packRows(0, this.rows - 1)
    this.emitRedraw(0, this.rows - 1)
  }

  private packCursorRow(): void {
    const row = this.cursorViewportRow()
    this.packRows(row, row)
  }

  /** The single funnel: every path that changes what a row should look like ends here.
   *
   *  Reads viewport/theme/cursor ONCE for the whole range — they cannot change mid-loop, and
   *  `theme()` in particular hands back the shell's cached snapshot, which there is no reason to
   *  re-read per row. */
  private packRows(from: number, to: number): void {
    if (this.disposed) return
    const start = Math.max(0, from)
    const end = Math.min(this.rows - 1, to)
    if (end < start || this.cols <= 0) return
    const theme = this.internals.theme()
    const viewportY = this.internals.viewportY()
    // -1 = no cursor anywhere in this pass (hidden by the app, or the terminal is not focused —
    // xterm draws a hollow outline there, which this engine has no flag for; painting nothing is
    // the honest v1 degradation and is what handleBlur repacks the row to produce).
    const cursorRow =
      this.focused && this.internals.cursorVisible()
        ? this.internals.baseY() + this.internals.cursorY() - viewportY
        : -1
    // CLAMPED, exactly as xterm's own renderers do (`Math.min(buffer.x, cols - 1)`): with a
    // deferred wrap pending, the buffer's x sits ON `cols`, one past the last column. Left
    // unclamped it matches no column and the cursor simply VANISHES at the end of a full line —
    // which is where a shell prompt spends much of its time.
    const cursorCol = Math.min(this.internals.cursorX(), this.cols - 1)
    for (let row = start; row <= end; row++) {
      this.absRow = viewportY + row
      packViewportRow(this.rowBuf, this.readCellBound, this.workCell, {
        cols: this.cols,
        atlas: this.atlas,
        theme,
        selection: this.selectionOnRow(this.absRow),
        // A block cursor on a DOUBLE-WIDTH glyph paints the left half only: the cursor is one
        // column and the glyph is two. Known v1 limitation (the two-column rule needs the wide
        // flag honoured in the shader) — visible, harmless, tracked for Phase 2.
        cursorCol: row === cursorRow ? cursorCol : -1
      })
      this.handle.updateRow(row, this.rowBuf)
    }
  }

  /** Column span [start, endExclusive) of the selection on one ABSOLUTE buffer row, or null.
   *
   *  Mirrors xterm's own selection render model exactly (DomRenderer.handleSelectionChanged):
   *  in column-select mode every row in range gets the same [min, max) rectangle; linearly, the
   *  first row starts at the start column, the last ends at the end column (EXCLUSIVE), and the
   *  rows between are full width. */
  private selectionOnRow(absRow: number): readonly [number, number] | null {
    const top = this.selTop
    const bottom = this.selBottom
    if (!top || !bottom) return null
    if (absRow < top[1] || absRow > bottom[1]) return null
    let startCol: number
    let endCol: number
    if (this.columnSelect) {
      startCol = Math.min(top[0], bottom[0])
      endCol = Math.max(top[0], bottom[0])
    } else {
      startCol = absRow === top[1] ? top[0] : 0
      endCol = absRow === bottom[1] ? bottom[0] : this.cols
    }
    return endCol > startCol ? [startCol, endCol] : null
  }

  /** Which VIEWPORT rows the current selection covers — the repaint unit, clamped to the grid. */
  private selectionRowRange(): RowRange {
    const top = this.selTop
    const bottom = this.selBottom
    if (!top || !bottom) return null
    const viewportY = this.internals.viewportY()
    const from = Math.max(0, top[1] - viewportY)
    const to = Math.min(this.rows - 1, bottom[1] - viewportY)
    return to < from ? null : [from, to]
  }

  private cursorViewportRow(): number {
    return this.internals.baseY() + this.internals.cursorY() - this.internals.viewportY()
  }

  /** Exactly xterm's own dimension math (DomRenderer._updateDimensions), which is why the shell
   *  hands over DEVICE metrics rather than css ones: css.cell is derived from the ROUNDED css
   *  canvas, and xterm maps mouse coordinates through it.
   *
   *  Every leaf is assigned IN PLACE — see the `dimensions` field. xterm's own renderers write
   *  their dimensions object the same way, for the same reason. */
  private updateDims(): void {
    const m = this.internals.deviceMetrics()
    const dpr = this.internals.dpr() || 1
    const cols = Math.max(0, this.cols)
    const rows = Math.max(0, this.rows)
    const d = this.dimensions
    d.device.char.width = m.charW
    d.device.char.height = m.charH
    d.device.char.left = 0
    d.device.char.top = 0
    d.device.cell.width = m.cellW
    d.device.cell.height = m.cellH
    d.device.canvas.width = m.cellW * cols
    d.device.canvas.height = m.cellH * rows
    d.css.canvas.width = Math.round(d.device.canvas.width / dpr)
    d.css.canvas.height = Math.round(d.device.canvas.height / dpr)
    // A zero-column grid would make these NaN, which propagates into xterm's mouse math.
    d.css.cell.width = cols > 0 ? d.css.canvas.width / cols : 0
    d.css.cell.height = rows > 0 ? d.css.canvas.height / rows : 0
  }

  private emitRedraw(start: number, end: number): void {
    if (this.disposed) return
    for (const cb of this.redrawListeners) cb({ start, end })
  }
}

/** Union of two inclusive row ranges as a list of ranges to repack. Overlapping or touching
 *  ranges collapse into one; disjoint ones stay separate, so a selection jumping from the top of
 *  the viewport to the bottom does not repack everything in between. */
function mergeRanges(a: RowRange, b: RowRange): Array<readonly [number, number]> {
  if (!a) return b ? [b] : []
  if (!b) return [a]
  const [lo, hi] = a[0] <= b[0] ? [a, b] : [b, a]
  if (hi[0] <= lo[1] + 1) return [[lo[0], Math.max(lo[1], hi[1])]]
  return [lo, hi]
}
