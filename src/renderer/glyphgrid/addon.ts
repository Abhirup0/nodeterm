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
import { resolveCursorShape, type CursorShape, type GridCursor } from './cursor'
import type { DecorationReader } from './decorations'
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

/** This terminal's end of the canvas cursor-blink clock: the clock hands the focused terminal its
 *  phase through here. Declared structurally rather than imported from the shared layer — this
 *  directory imports nothing — and it is the same shape as the layer's `CursorBlinkTarget`. */
export interface CursorBlinkPhaseTarget {
  setPhase(visible: boolean): void
}

/**
 * How the addon publishes WHICH terminal the canvas's single blink clock should be driving.
 *
 * The addon is the only thing that can answer it: it tracks focus itself (see `focused`), and a
 * focused block cursor produces no overlay at all, so focus is invisible from the engine side.
 *
 * OPTIONAL, like the decorations: a build with no shared layer hands over nothing and the cursor
 * simply never blinks — Phase 1b's behaviour, not a broken renderer.
 *
 * `release(target)` rather than a bare `setTarget(null)`, and it is IDENTITY-GUARDED by the shell:
 * browsers do not promise that the blurred terminal's blur reaches us before the newly focused
 * one's focus, and an unconditional clear on a late blur would stop the cursor of the terminal the
 * user just clicked into — the only one that is supposed to be blinking.
 */
export interface CursorBlinkSeam {
  claim(target: CursorBlinkPhaseTarget): void
  release(target: CursorBlinkPhaseTarget): void
  /** The cursor MOVED: hold it solid and start the period over, exactly as xterm's own
   *  `CursorBlinkStateManager.restartBlinkAnimation` does. Identity-guarded in the shell like
   *  `release`, and for a second reason on top of that one — a background terminal streaming output
   *  moves its cursor constantly, and any of them re-arming the focused terminal's period would
   *  hold the blink permanently solid. */
  restart(target: CursorBlinkPhaseTarget): void
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
  /** xterm's `options.cursorStyle` and `options.cursorInactiveStyle`, verbatim strings.
   *
   *  OPTIONAL, and read on every pack rather than cached: the user can change either from Settings
   *  at any moment, and the option object is the shell's live view of the terminal. A build that
   *  reports neither degrades to xterm's own defaults (a focused block, a blurred outline) —
   *  a bumped xterm must cost the user their chosen SHAPE, never their cursor.
   *
   *  The FOCUS half is deliberately not read from here: this addon tracks focus itself (see
   *  `focused`), because whether the browser service's flag has flipped by the time xterm calls
   *  handleBlur is an ordering detail the cursor's correctness must not rest on. */
  cursorStyle?(): { style?: string; inactiveStyle?: string }
  /** The canvas's blink clock, or undefined on a build that has none. See `CursorBlinkSeam`. */
  blink?: CursorBlinkSeam
  /** The terminal's decorations — the cell colours a ⌘F hit paints — or undefined.
   *
   *  ALL THREE DECORATION MEMBERS ARE OPTIONAL, together: an xterm build whose decoration service
   *  is missing or reshaped must degrade to "this terminal has no highlights", never to a refused
   *  attach or a terminal on no renderer at all. The shell decides that once and hands over either
   *  the whole trio or none of it. */
  decorations?: DecorationReader
  onDecorationRegistered?(cb: () => void): { dispose(): void }
  onDecorationRemoved?(cb: () => void): { dispose(): void }
  /**
   * The link the pointer is currently over, in VIEWPORT cell coordinates, or null.
   *
   * xterm reports a hovered link as a range and its own render layers answer by underlining it —
   * the affordance that says ⌘-click will open this. Replacing xterm's renderer removes those
   * layers, so this renderer has to draw it, or every link looks inert (reported 2026-08-05).
   *
   * OPTIONAL like the decorations, and for the same reason: a build whose linkifier is missing or
   * reshaped degrades to "no link underlines", never to a refused attach.
   */
  linkUnderline?: LinkUnderline
}

/**
 * A hovered link's extent, in VIEWPORT cell coordinates — the shape xterm's linkifier fires
 * (`y` already has `ydisp` subtracted). Inclusive on both ends, as xterm reports it.
 */
export interface LinkUnderline {
  /** The current range, or null when nothing is hovered. Read once per pack. */
  current(): { x1: number; y1: number; x2: number; y2: number } | null
  /** Fires when the hovered range changes, so the shell can repaint the rows it covers. */
  onChange(cb: () => void): { dispose(): void }
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
  /**
   * Whether the CELLS currently hold an inverted block cursor — i.e. the block-ness of the last pack
   * that actually covered the cursor row.
   *
   * The two halves of the cursor are updated on different schedules: the OVERLAY is re-pushed by
   * every pack (it is a property of the terminal, not of the rows), while the CELL half only changes
   * on a pack that covers the cursor row. A style change that flips block-ness between those two —
   * `cursorInactiveStyle` going `block` → `outline` while the terminal is blurred, then a
   * drag-select, which packs only the selected rows — would leave an outline drawn AROUND a cell
   * that is still inverted, or (the other direction) clear the overlay and leave no cursor at all.
   * Remembering what the cells show is what lets `packRows` notice and repaint the cursor row.
   *
   * Kept HERE rather than closing the same gap by subscribing to xterm's
   * `onSpecificOptionChange('cursorInactiveStyle')` through the shell: that would widen the shell's
   * private-xterm surface (the thing this whole split exists to keep small) for a setting nobody
   * touches at runtime, and it would only cover the option — this covers every way the two halves
   * can drift apart, including a focus change racing a pack.
   */
  private cellCursorBlock: boolean

  /**
   * Whether the canvas's blink clock currently wants this terminal's cursor SHOWN.
   *
   * A third reason a cursor may not be drawn this instant, independent of focus and of the app's
   * own DECTCEM state — see `cursorShown`, which is the single place the three meet. True whenever
   * no clock is driving this terminal, so every terminal that is not the blink target (and every
   * terminal at all, on a build with no shared layer) draws exactly as it did before.
   */
  private blinkVisible = true

  /** ONE object for the addon's lifetime, handed to the clock on every focus edge. Identity is the
   *  contract, not an optimization: the clock is change-gated on it (`next !== current`, and
   *  `setCursorBlinkTarget` compares by reference), so a fresh object per focus event would restart
   *  the blink period every time a focus notification arrived. */
  private readonly blinkSelf: CursorBlinkPhaseTarget = {
    setPhase: (visible: boolean): void => this.setCursorBlinkPhase(visible)
  }

  /** Mutable because `readCellBound` closes over it: one closure for the lifetime of the addon
   *  instead of one per packed row. */
  private absRow = 0
  private readonly readCellBound = (col: number, into: CellView): CellView | undefined =>
    this.internals.readCell(this.absRow, col, into)

  /** Live for the addon's whole life; disposed in `dispose()`. The atlas is SHARED by every
   *  terminal on the canvas, so a subscription left behind holds a torn-down addon alive and asks
   *  it to repack rows into a grid its node has already dropped. */
  private readonly atlasResetSub: GlyphAtlasSubscription

  /** The terminal's decoration events, empty when it has no decoration service. Disposed with the
   *  addon for the same reason the atlas subscription is: a live subscription on a terminal that
   *  outlives its renderer (an attach that was swapped back to DOM) would go on asking a dead addon
   *  to redraw a grid its node has dropped. */
  private readonly decorationSubs: Array<{ dispose(): void }> = []

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
    // Seeded from the CURRENT shape rather than from `false`: no row has been packed yet, so there
    // is no stale block to heal, and seeding the other way would spend one repack of the cursor row
    // on the first pack of every terminal that misses it.
    this.cellCursorBlock = this.cursorShape() === 'block'
    this.updateDims()
    // EVERY subscription goes last, and they go TOGETHER. The shell catches a failing construction
    // and restores the DOM renderer without ever holding an addon to dispose, so anything
    // subscribed before a throw is disposed by nobody and keeps the dead addon reachable from the
    // object it subscribed to. That is the whole invariant, and it does not care which of these is
    // likelier to throw — splitting them to put the "riskier" pair first only widens the window it
    // exists to close.
    this.atlasResetSub = this.atlas.onReset(() => this.handleAtlasReset())
    const onRegistered = internals.onDecorationRegistered
    const onRemoved = internals.onDecorationRemoved
    if (onRegistered) this.decorationSubs.push(onRegistered(() => this.handleDecorationChange()))
    if (onRemoved) this.decorationSubs.push(onRemoved(() => this.handleDecorationChange()))
    // The hovered link changes with the POINTER, not with the buffer, so nothing else would ever
    // repaint those rows: without this the underline appears only when some unrelated output
    // happens to redraw the line under the cursor. Shares the decoration bag — same lifetime, same
    // teardown, and one fewer thing for `dispose` to remember.
    const onLink = internals.linkUnderline?.onChange
    if (onLink) {
      this.decorationSubs.push(
        internals.linkUnderline!.onChange(() => this.handleDecorationChange())
      )
    }
    // LAST, and after the subscriptions, for the same reason they go last: this publishes the addon
    // into a CANVAS-LEVEL singleton, and a construction that threw afterwards would leave it there
    // with nobody holding an addon to release it. Seeded rather than waited for, because a mode
    // switch or a remount attaches to a terminal the user is already typing in — a clock that only
    // learned about focus on the next focus EVENT would leave that cursor static.
    this.publishBlinkTarget()
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
    // FIRST, before the packs, and only for the terminal that HAS focus. xterm's own cursor holds
    // solid while you type (`CursorBlinkStateManager.restartBlinkAnimation`), and a STACKED terminal
    // beside this one is drawing exactly that on xterm's DOM renderer — a shared cursor that kept
    // flashing through a keystroke is the drift `CURSOR_BLINK_INTERVAL_MS` was matched to prevent.
    //
    // Its position in this method is what keeps the restart's repaint inside the clock's bracket:
    // the clock shows the cursor synchronously from here, so that repaint takes `pulse()`. The two
    // packs below are ordinary damage — but the engine notifies only on the clean→dirty EDGE, so
    // whichever write lands first is the one that routes, and a keystroke therefore costs a pulse
    // rather than a wake. That is fine and deliberate: either route reaches a FRAME, which is the
    // invariant, and the bracket exists to keep the blink's TIMED repaints off the wake path — not
    // to make sure typing takes it.
    if (this.focused) this.internals.blink?.restart(this.blinkSelf)
    const next = this.cursorViewportRow()
    const prev = this.lastCursorRow
    this.lastCursorRow = next
    this.packRows(next, next)
    if (prev !== next) this.packRows(prev, prev)
  }

  handleBlur(): void {
    if (this.disposed) return
    this.focused = false
    this.repaintFocusDependent()
    // AFTER the repaint: releasing makes the clock restore this cursor to its shown phase, and it
    // must restore the blurred SHAPE, which `repaintFocusDependent` has just established.
    this.publishBlinkTarget()
  }

  handleFocus(): void {
    if (this.disposed) return
    this.focused = true
    this.repaintFocusDependent()
    this.publishBlinkTarget()
  }

  /**
   * The canvas blink clock's phase for THIS terminal — show or hide its cursor for the half-period.
   *
   * SYNCHRONOUS, and that is the contract rather than an implementation detail. The clock brackets
   * this call so the damage it produces is routed to the frame loop's one-shot `pulse()` instead of
   * `wake()` (see `CursorBlinkTarget` in `canvas/SharedGlyphLayer.tsx`): a repack deferred to a
   * redraw request — the way an atlas reset and a decoration change defer theirs — would land
   * OUTSIDE that bracket, take the wake path, and re-arm the 30-frame idle streak twice a second.
   * That is Phase 1c's idle park silently undone on every canvas with a focused terminal, i.e. the
   * exact failure the clock exists to prevent. So the row is packed here, on the caller's stack;
   * this must never become an `emitRedraw`.
   *
   * BOTH halves go together, which is why only the addon can apply a phase: `packRows` re-pushes
   * the overlay (`syncCursor`) before it packs, and `cursorShown()` gates the cell half in the same
   * breath — so a block's cell inversion and every other shape's overlay disappear on one phase.
   */
  setCursorBlinkPhase(visible: boolean): void {
    if (this.disposed || this.blinkVisible === visible) return
    this.blinkVisible = visible
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
    // BEFORE `disposed`, deliberately: the clock restores the phase from inside its release path,
    // and an addon already flipped inert would swallow that `setPhase(true)` — leaving the last
    // packed row without the cursor the blink happened to be hiding. Identity-guarded in the shell,
    // so a terminal torn down after another has taken focus cannot stop the new one's blink.
    this.releaseBlinkTarget()
    this.disposed = true
    // The overlay cursor is a GRID-level value, so — unlike a packed row — nothing will ever
    // overwrite it. A renderer swapped back to xterm's DOM one would otherwise leave a bar or an
    // outline painted on the shared canvas under a terminal now drawing its own. A silent no-op when
    // the owner has already dropped the handle, which is the ordinary teardown order.
    this.handle.setCursor(null)
    this.redrawListeners.clear()
    this.atlasResetSub.dispose()
    for (const sub of this.decorationSubs) sub.dispose()
    this.decorationSubs.length = 0
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
   * AND WHY A TERMINAL THAT IS OFF-SCREEN AT RESET TIME STILL HEALS — the mechanism the correctness
   * above quietly rests on. A redraw request for a grid nobody can see does not evaporate at either
   * end: xterm's RenderService answers `refreshRows` on a PAUSED terminal (its intersection observer
   * saw it leave the viewport) by setting `_needsFullRefresh` and flushing that full refresh the
   * moment the terminal intersects again, and the engine's damage is likewise visibility-scoped
   * rather than visibility-dropped — the repacked rows are uploaded on the frame that brings the
   * grid back. Note the timing, because it widens the "one frame" above: the observer lifts the
   * pause ASYNCHRONOUSLY and the refresh it schedules is debounced, so a grid panned back into view
   * right after a reset can show stale glyphs for a FEW frames, not exactly one.
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

  /**
   * A decoration was registered or removed — a ⌘F search adding a hit, or the find bar closing and
   * dropping all of them. Decorations change cell COLOURS, so the rows have to be re-fed; the ATLAS
   * is untouched (its slots are keyed by colour, and the ones this asks for next are simply
   * different keys), so nothing needs clearing.
   *
   * DEFERRED, through the same `onRequestRedraw` path an atlas reset uses, and for the same reason:
   * this fires from wherever the decoration owner happens to be — the search addon's own loop, a
   * dispose, a marker being trimmed out of the buffer — and packing rows from inside someone else's
   * call is exactly the re-entrancy `handleAtlasReset` documents at length. Handing the repack to
   * RenderService also coalesces the burst a search produces (one event per match) into a single
   * debounced render pass, instead of repacking every row per hit.
   */
  private handleDecorationChange(): void {
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

  /** Everything a focus change repaints. The cursor row, because its shape changes (a focused block
   *  becomes a blurred outline), AND the selected rows, because an unfocused terminal's selection is
   *  painted in a quieter colour (limitation L3). Repacking only the cursor row — which is what this
   *  used to do — left the selection band bright until something unrelated happened to touch it. */
  private repaintFocusDependent(): void {
    this.packCursorRow()
    const sel = this.selectionRowRange()
    if (sel) this.packRows(sel[0], sel[1])
  }

  /** Tell the canvas's blink clock whether this terminal is the one to blink. Called on every focus
   *  edge and once at construction; `dispose` uses `releaseBlinkTarget` directly, because by then
   *  the answer is "nobody" whatever the focus flag says. */
  private publishBlinkTarget(): void {
    if (this.focused) this.internals.blink?.claim(this.blinkSelf)
    else this.releaseBlinkTarget()
  }

  private releaseBlinkTarget(): void {
    this.internals.blink?.release(this.blinkSelf)
  }

  /**
   * Is the cursor drawn at all right now?
   *
   * Two independent reasons it may not be — the app's own DECTCEM state (a TUI hiding it) and the
   * blink clock's phase — and every path that draws EITHER half asks this one question, which is
   * what keeps the cell half and the overlay half from ever disagreeing about a phase. Focus is
   * deliberately not in here: a blurred terminal still has a cursor, it just wears a different
   * shape (see `cursorShape`).
   */
  private cursorShown(): boolean {
    return this.blinkVisible && this.internals.cursorVisible()
  }

  /** The shape the cursor takes right now, from the shell's options and OUR focus flag. */
  private cursorShape(): CursorShape {
    const opts = this.internals.cursorStyle?.()
    return resolveCursorShape(this.focused, opts?.style, opts?.inactiveStyle)
  }

  /**
   * The overlay cursor this grid should draw, or null.
   *
   * Null for a BLOCK as well as for `none`: a block is a cell rewrite (only that path can invert the
   * glyph under it), and drawing it here too would paint an opaque quad over the inversion the feed
   * just produced. Null for a cursor that is not shown right now (`cursorShown` — DECTCEM inside a
   * TUI, or the blink's hidden phase) and for one scrolled out of the viewport, both for the same
   * reason: the overlay is a GRID-level value, so nothing else would ever erase a stale one —
   * unlike a packed row, which the next frame rewrites wholesale.
   */
  private cursorSpec(): GridCursor | null {
    const shape = this.cursorShape()
    if (shape === 'block' || shape === 'none') return null
    if (!this.cursorShown()) return null
    if (this.cols <= 0 || this.rows <= 0) return null
    const row = this.cursorViewportRow()
    if (row < 0 || row >= this.rows) return null
    // Clamped exactly as the cell path clamps it: with a deferred wrap pending the buffer's x sits
    // ON `cols`, and an overlay drawn there would hang off the right edge of the terminal.
    const col = Math.min(this.internals.cursorX(), this.cols - 1)
    const cell = this.internals.readCell(
      this.internals.baseY() + this.internals.cursorY(),
      col,
      this.workCell
    )
    return {
      col,
      row,
      shape,
      // A wide glyph's lead: the cursor covers the whole character, not its left half (L13). Read
      // from the CELL, since the cursor's column says nothing about how wide what it sits on is.
      widthCells: cell && cell.getWidth() === 2 ? 2 : 1,
      color: this.internals.theme().cursorBg
    }
  }

  /** Push the current overlay cursor at the grid. Cheap and idempotent — the engine change-gates it
   *  — which is what lets every pack path call it without reasoning about whether it moved. */
  private syncCursor(): void {
    this.handle.setCursor(this.cursorSpec())
  }

  /** The single funnel: every path that changes what a row should look like ends here.
   *
   *  Reads viewport/theme/cursor ONCE for the whole range — they cannot change mid-loop, and
   *  `theme()` in particular hands back the shell's cached snapshot, which there is no reason to
   *  re-read per row. */
  private packRows(from: number, to: number): void {
    if (this.disposed) return
    // FIRST, and independent of the range: the overlay cursor is a property of the terminal, not of
    // the rows this pass happens to touch, and every path that repacks anything is also a path
    // along which the cursor may have moved, changed shape or gone away.
    this.syncCursor()
    const start = Math.max(0, from)
    const end = Math.min(this.rows - 1, to)
    if (end < start || this.cols <= 0) return
    const theme = this.internals.theme()
    const viewportY = this.internals.viewportY()
    // -1 = no cursor row in this pass — the app hid it (DECTCEM inside a TUI) or the blink clock is
    // in its hidden phase. The two share this branch on purpose: `settleCursorCells` already knows
    // that a cursor row of -1 means "there is no block to keep in step with", so a phase costs no
    // repair repack and can never paint a block back onto the row it just cleared. NOT focus-gated:
    // a blurred terminal still has a cursor, it just wears a different shape, and which of the two
    // paths draws it is `cursorShape`'s answer below — not this row's.
    const cursorRow = this.cursorShown()
      ? this.internals.baseY() + this.internals.cursorY() - viewportY
      : -1
    // Resolved ONCE for the range: only a `block` is a cell rewrite, and the feed ignores
    // `cursorCol` for every other shape (the overlay pass draws those — see `cursorSpec`).
    const cursorShape = this.cursorShape()
    // CLAMPED, exactly as xterm's own renderers do (`Math.min(buffer.x, cols - 1)`): with a
    // deferred wrap pending, the buffer's x sits ON `cols`, one past the last column. Left
    // unclamped it matches no column and the cursor simply VANISHES at the end of a full line —
    // which is where a shell prompt spends much of its time.
    const cursorCol = Math.min(this.internals.cursorX(), this.cols - 1)
    // Read once for the whole range, like the theme: the shell builds the reader once and keeps it
    // live for the terminal's lifetime.
    const decorations = this.internals.decorations
    for (let row = start; row <= end; row++) {
      this.absRow = viewportY + row
      packViewportRow(this.rowBuf, this.readCellBound, this.workCell, {
        cols: this.cols,
        atlas: this.atlas,
        theme,
        selection: this.selectionOnRow(this.absRow),
        // VIEWPORT row, not the absolute one: xterm's linkifier already subtracted `ydisp` when it
        // fired, so the range is in the coordinates the user is currently looking at.
        linkUnderline: this.linkOnRow(row),
        cursorCol: row === cursorRow ? cursorCol : -1,
        cursorShape,
        // Only the SELECTION colour depends on this (an unfocused terminal's band is quieter — L3);
        // the blurred cursor is a shape, and shapes are the overlay's business.
        focused: this.focused,
        decorations,
        // Decoration markers are keyed by ABSOLUTE buffer row, so this is the row the lookup needs
        // — the viewport row would slide the highlights off their matches on every scroll.
        bufferRow: this.absRow
      })
      this.handle.updateRow(row, this.rowBuf)
    }
    this.settleCursorCells(cursorRow, cursorShape === 'block', start, end)
  }

  /**
   * Keep the CELL half of the cursor in step with the OVERLAY half across packs.
   *
   * Runs after the loop, so the ordinary case is a bookkeeping write: a pack that covered the cursor
   * row has just repainted it, and what it painted is now what the cells show. The other branch is
   * the repair — the cursor row was NOT in this range and its block-ness has changed since it was
   * last packed, which is the `cursorInactiveStyle` flip described on `cellCursorBlock`. Left alone
   * it shows as an outline drawn around a still-inverted cell, or as no cursor at all.
   *
   * TERMINATION, because this re-enters `packRows`: the repack it asks for covers the cursor row by
   * construction, so the nested call takes the first branch and cannot ask again. A cursor row
   * outside the grid (scrolled away, hidden by the app) takes neither branch — there is no stale
   * block to heal there, and asking for a row the pack would clamp away is what a loop would be
   * made of.
   */
  private settleCursorCells(cursorRow: number, block: boolean, start: number, end: number): void {
    if (cursorRow < 0 || cursorRow >= this.rows) return
    if (cursorRow >= start && cursorRow <= end) {
      this.cellCursorBlock = block
      return
    }
    if (this.cellCursorBlock === block) return
    this.packCursorRow()
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

  /**
   * The hovered link's column span on this VIEWPORT row, `[startCol, endColExclusive)`, or null.
   *
   * xterm's range is INCLUSIVE at both ends and can span rows; a middle row is covered edge to
   * edge. The `+ 1` on the end column is that inclusive→exclusive conversion, and forgetting it
   * leaves the link's last character un-underlined — a one-cell gap that reads as a rendering bug
   * rather than as an off-by-one.
   */
  private linkOnRow(row: number): readonly [number, number] | null {
    const link = this.internals.linkUnderline?.current()
    if (!link) return null
    if (row < link.y1 || row > link.y2) return null
    const startCol = row === link.y1 ? link.x1 : 0
    const endCol = row === link.y2 ? link.x2 + 1 : this.cols
    return endCol > startCol ? [Math.max(0, startCol), Math.min(this.cols, endCol)] : null
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
