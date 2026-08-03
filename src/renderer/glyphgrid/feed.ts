/** The color/glyph brain of the xterm integration: buffer cells in, engine lanes out.
 *
 *  This module imports NOTHING from xterm — everything arrives through `CellView` (a narrow view
 *  of `IBufferCell`) and `ThemeLanes` (a snapshot of the theme already packed into the engine's
 *  color space). That is what keeps it pure, headless-testable and free of a dependency on
 *  xterm's internals, which are the part of that library most likely to move under us. */

import type { GlyphAtlas } from './atlas'
import {
  FLAG_BOLD,
  FLAG_CURSOR,
  FLAG_ITALIC,
  FLAG_SELECTED,
  FLAG_UNDERLINE,
  FLAG_WIDE,
  packColor,
  writeCell
} from './cells'

/** Narrow view of one buffer cell — the subset of xterm's IBufferCell the feed reads. The shell
 *  passes real cells; tests pass literals. */
export interface CellView {
  getCode(): number
  getWidth(): number
  isBold(): number
  isItalic(): number
  isUnderline(): number
  isInverse(): number
  isDim(): number
  isFgDefault(): boolean
  isFgPalette(): boolean
  isFgRGB(): boolean
  isBgDefault(): boolean
  isBgPalette(): boolean
  isBgRGB(): boolean
  getFgColor(): number // palette index | 0xRRGGBB when RGB
  getBgColor(): number
}

/** Snapshot of the theme in the engine's packed-color space (packColor lanes). Built once per
 *  theme change by the shell from _themeService.colors: rgb = (color.rgba >> 8) & 0xffffff. */
export interface ThemeLanes {
  fg: number // packColor default foreground
  bg: number // packColor default background (opaque)
  ansi: number[] // 256 packed colors (16 base + 240 extended)
  cursorFg: number // glyph color when under the block cursor
  cursorBg: number
  selectionBg: number // opaque selection background
}

export interface RowFeedOpts {
  cols: number
  atlas: Pick<GlyphAtlas, 'glyphFor'>
  theme: ThemeLanes
  /** Selection span on THIS viewport row, in columns [startCol, endColExclusive), or null. */
  selection: readonly [number, number] | null
  /** Block-cursor column on THIS row, or -1. (Bar/underline cursors: Phase 2 — block only.) */
  cursorCol: number
}

const MAX_CODE_POINT = 0x10ffff

/** Whether a code point may reach the atlas — i.e. whether `String.fromCodePoint(code)` in the
 *  rasterizer is safe AND worth a slot.
 *
 *  This is a CRASH GUARD, not a nicety: `String.fromCodePoint` THROWS a RangeError on a negative,
 *  non-integer, or out-of-range argument, and a lone surrogate (0xD800-0xDFFF) rasterizes to
 *  garbage. A buffer cell can hold any of those after a malformed UTF-8 run, and the throw would
 *  take down the whole frame — the Phase 0 review's Task-4 crash class.
 *
 *  Everything at or below 0x20 is excluded too, for a different reason: control codes have no
 *  printable form, and space (0x20) is the most common cell on the canvas — answering it here
 *  saves a map lookup per blank cell (the atlas would return slot 0 for it anyway). */
function isRenderableCode(code: number): boolean {
  return (
    Number.isInteger(code) &&
    code > 0x20 &&
    code <= MAX_CODE_POINT &&
    !(code >= 0xd800 && code <= 0xdfff)
  )
}

/** 0xRRGGBB (xterm's RGB encoding) → an opaque packed lane. */
function rgbLane(v: number): number {
  return packColor((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff, 0xff)
}

/** A palette index outside the theme's 256 entries falls back to the default rather than writing
 *  `undefined` (which a Uint32Array silently stores as 0 = transparent black). */
function paletteLane(theme: ThemeLanes, index: number, fallback: number): number {
  const c = theme.ansi[index]
  return typeof c === 'number' ? c : fallback
}

/** DIM halves the RGB channels and keeps alpha. NOTE: xterm's own renderers dim by drawing the
 *  foreground at 50% OPACITY (blending toward the background); halving the channels blends toward
 *  black instead. The two agree on a dark background and differ on a light one — matching xterm's
 *  blend is Phase 2 work, and needs the resolved bg, so it belongs here when it lands. */
function dimLane(c: number): number {
  return packColor(
    (c & 0xff) >>> 1,
    ((c >>> 8) & 0xff) >>> 1,
    ((c >>> 16) & 0xff) >>> 1,
    (c >>> 24) & 0xff
  )
}

function resolveFg(cell: CellView, theme: ThemeLanes): number {
  if (cell.isFgPalette()) return paletteLane(theme, cell.getFgColor(), theme.fg)
  if (cell.isFgRGB()) return rgbLane(cell.getFgColor())
  return theme.fg // isFgDefault, and anything unclassifiable
}

function resolveBg(cell: CellView, theme: ThemeLanes): number {
  if (cell.isBgPalette()) return paletteLane(theme, cell.getBgColor(), theme.bg)
  if (cell.isBgRGB()) return rgbLane(cell.getBgColor())
  return theme.bg
}

/** Pack one viewport row into engine lanes. PURE. Row buffer is caller-provided and reused.
 *
 *  ORDER OF RESOLUTION (each step depends on the previous one — do not reorder):
 *    1. resolve fg and bg independently (default / palette / RGB),
 *    2. INVERSE swaps the RESOLVED pair — so "inverse on a palette fg" moves that palette color
 *       into the background, which is what makes inverse composable with any color mode,
 *    3. DIM halves the foreground that step 2 left in place (never the background).
 *  This matches xterm's own renderers, which swap during resolution and apply dim to whatever
 *  foreground came out of it.
 *
 *  BOLD selects the bold glyph variant only — no bright-color promotion, matching modern xterm's
 *  default `drawBoldTextInBrightColors: false`. Making that an option is Phase 2 work.
 *
 *  WIDE / ZERO-WIDTH cells are one mechanism seen from two sides. A double-width glyph occupies
 *  two buffer cells: the lead reports width 2, and the cell right after it reports width 0. The
 *  lead carries the glyph (plus FLAG_WIDE); the follower is written as a BLANK cell carrying the
 *  LEAD's colors, so the background under a wide glyph — a selection, the cursor, a colored
 *  block — is one unbroken run instead of two halves that can disagree. The follower is never
 *  skipped: this row buffer is REUSED across frames, so "write nothing" would leave the previous
 *  frame's lanes standing at that column. Every column in [0, cols) is always written.
 *
 *  CURSOR and SELECTION are applied last, over whatever the cell resolved to. Selection repaints
 *  only the background (the foreground must stay readable as itself); the cursor repaints both.
 *  On overlap the CURSOR WINS the colors, and BOTH flags stay set — the flags describe the cell's
 *  state (this cell is selected AND under the cursor), only the paint has to pick a winner. */
export function packViewportRow(
  out: Uint32Array,
  readCell: (col: number, into: CellView) => CellView | undefined,
  workCell: CellView,
  opts: RowFeedOpts
): void {
  const { cols, atlas, theme, selection, cursorCol } = opts
  const selStart = selection ? selection[0] : -1
  const selEnd = selection ? selection[1] : -1

  // Colors carried from a wide lead into its zero-width follower (see the doc comment).
  let carryPending = false
  let carryFg = 0
  let carryBg = 0

  for (let col = 0; col < cols; col++) {
    const cell = readCell(col, workCell)
    let glyph = 0
    let fg = theme.fg
    let bg = theme.bg
    let flags = 0

    if (cell) {
      fg = resolveFg(cell, theme)
      bg = resolveBg(cell, theme)
      if (cell.isInverse()) {
        const swap = fg
        fg = bg
        bg = swap
      }
      if (cell.isDim()) fg = dimLane(fg)

      const width = cell.getWidth()
      if (width === 0) {
        // Second half of the preceding wide glyph: no glyph of its own, and the lead's colors
        // when we have them (a stray width-0 cell with no lead keeps its own — still never
        // stale). Glyph-styling flags mean nothing on a blank; underline continuity across a
        // wide glyph is Phase 2, since nothing renders underline yet.
        if (carryPending) {
          fg = carryFg
          bg = carryBg
        }
        carryPending = false
      } else {
        const bold = cell.isBold() !== 0
        const italic = cell.isItalic() !== 0
        const code = cell.getCode()
        if (isRenderableCode(code)) glyph = atlas.glyphFor(code, bold, italic)
        if (bold) flags |= FLAG_BOLD
        if (italic) flags |= FLAG_ITALIC
        if (cell.isUnderline() !== 0) flags |= FLAG_UNDERLINE
        if (width === 2) {
          flags |= FLAG_WIDE
          carryPending = true
          carryFg = fg
          carryBg = bg
        } else {
          carryPending = false
        }
      }
    } else {
      // Past the end of a short line (or no line at all): a blank cell on the theme background.
      carryPending = false
    }

    if (col >= selStart && col < selEnd) {
      bg = theme.selectionBg
      flags |= FLAG_SELECTED
    }
    if (col === cursorCol) {
      fg = theme.cursorFg
      bg = theme.cursorBg
      flags |= FLAG_CURSOR
    }

    writeCell(out, col, glyph, fg, bg, flags)
  }
}
