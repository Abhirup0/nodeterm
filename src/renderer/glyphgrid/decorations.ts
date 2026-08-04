/** Decorations — the cell-level colour overrides a terminal paints UNDER its text. xterm's search
 *  addon registers one per match, which is the whole reason this module exists: without it the
 *  shared renderer finds and scrolls to a hit and shows nothing highlighted.
 *
 *  Like the rest of this directory it imports NOTHING from xterm. The terminal's decoration service
 *  is private internals, so `src/renderer/terminal/glyphgrid-attach.ts` wraps it into the
 *  `DecorationReader` below and the feed consumes only that interface — the same injection shape
 *  `atlas` and `theme` already use, and what lets this be unit-tested against a fake. */

/** The overrides one cell's decorations impose, in the engine's packed-colour space (`packColor`
 *  lanes). `undefined` means "no override" — a decoration that carries only a background must not
 *  repaint the foreground black. */
export interface CellDecoration {
  bg?: number
  fg?: number
}

export interface DecorationReader {
  /** True when the terminal currently has NO decorations at all — the whole per-cell walk is
   *  skipped on this answer, which is the common case (nobody has ⌘F open). */
  empty(): boolean
  /** xterm's own `forEachDecorationAtCell` signature, narrowed: `row` is the ABSOLUTE buffer row
   *  (decoration markers are keyed absolutely, so a viewport row would highlight the wrong line the
   *  moment the buffer scrolls), and each entry arrives with its colours already packed. */
  atCell(
    col: number,
    row: number,
    cb: (d: { layer?: string; bg?: number; fg?: number }) => void
  ): void
}

/**
 * The overrides a cell's decorations impose, or null.
 *
 * WHY 'top' IS SKIPPED, AND WHAT THAT COSTS. Both of xterm's renderers resolve decorations at CELL
 * level and do it twice in one pass: `bottom` BEFORE the selection is applied, `top` AFTER it — so
 * a top-layer decoration outranks the selection band, not merely the base colours. This engine
 * resolves a cell once, in the feed, with the selection last, and expressing "after the selection"
 * would mean a second override stage.
 *
 * That is a DEVIATION, said plainly rather than dressed up as something xterm cannot do either: a
 * top-layer decoration renders as NOTHING here. It costs nothing today — `registerDecoration` has
 * no caller anywhere in `src/`, and `@xterm/addon-search`, the reason this module exists, registers
 * its matches with no layer at all, which is BOTTOM by xterm's own `options.layer ?? 'bottom'`. If a
 * top-layer decoration is ever shipped, this function is where the second stage has to go.
 *
 * LAST WRITER WINS, per channel, matching the callback order xterm hands out — two decorations on
 * one cell is already ambiguous, and agreeing with the renderer we are replacing is the only
 * defensible answer.
 *
 * THE `empty()` FAST PATH IS NOT AN OPTIMIZATION DETAIL. This runs for every cell of every packed
 * row; on the common canvas nothing is decorated at all, and one boolean per cell is the difference
 * between that costing nothing and costing a call into xterm's service per cell.
 */
export function decorationAt(
  reader: DecorationReader,
  col: number,
  row: number
): CellDecoration | null {
  if (reader.empty()) return null
  let bg: number | undefined
  let fg: number | undefined
  reader.atCell(col, row, (d) => {
    if (d.layer === 'top') return
    if (d.bg !== undefined) bg = d.bg
    if (d.fg !== undefined) fg = d.fg
  })
  return bg === undefined && fg === undefined ? null : { bg, fg }
}
