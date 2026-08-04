/** The cursor's geometry, and nothing else: shapes in, rects in cell units out.
 *
 *  Like the rest of this directory it imports NOTHING — no GL, no xterm. The two option strings it
 *  resolves a shape from arrive as plain strings through the attach shell, so a bumped xterm that
 *  renames or extends them breaks one file (`glyphgrid-attach.ts`) rather than this one.
 *
 *  THE SPLIT THIS MODULE EXISTS TO EXPRESS. A BLOCK cursor is a CELL REWRITE — the feed swaps the
 *  cell's fg/bg for the cursor pair, which is the only way the glyph under it can be inverted, since
 *  the atlas is colour-keyed and the slot is rasterized in the colours it was asked for. Every OTHER
 *  shape draws NEXT TO the glyph rather than through it, so it is an overlay: a handful of small
 *  quads drawn after the cells, in the cursor colour, sampling no atlas. `cursorOverlays` returns
 *  `[]` for `block` for exactly that reason — it is not "unimplemented", it is the cell path's job —
 *  and the two must never be unified: a unified path would either lose the inversion or draw the
 *  block twice, once inverted and once as an opaque quad over the glyph it just inverted. */

/** The shapes this renderer can draw. Superset of xterm's `cursorStyle` (block/bar/underline) and
 *  `cursorInactiveStyle` (those three plus outline/none) — see `resolveCursorShape`. */
export type CursorShape = 'block' | 'bar' | 'underline' | 'outline' | 'none'

/** One overlay rect, relative to the TOP-LEFT of the cursor's cell and in the SAME units as the
 *  `cellW`/`cellH` it was computed from (world units — CSS px at zoom 1). Not normalized: the caller
 *  adds the cell's world origin and hands the result to the GPU, and a 0..1 fraction would only mean
 *  every call site multiplying by the cell again. */
export interface CursorOverlay {
  x: number
  y: number
  w: number
  h: number
}

/** Everything a draw needs to know about one grid's cursor. Lives here rather than in `gl.ts`
 *  because `shape` is this module's type and the rects are this module's job; `gl.ts` consumes it
 *  through `GridDrawParams.cursor`.
 *
 *  `widthCells` is 2 on a wide glyph's LEAD and 1 everywhere else — the cursor covers the whole
 *  character, not the left half of it (limitation L13). `color` is a packed lane (`packColor`),
 *  normally the theme's cursor background. */
export interface GridCursor {
  col: number
  row: number
  shape: CursorShape
  widthCells: number
  color: number
}

/** The most rects any shape produces (`outline`'s four edges) — the overlay pass sizes its uniform
 *  array from this, so the two cannot drift apart. */
export const MAX_CURSOR_RECTS = 4

/** One CSS pixel at zoom 1 — the same hairline xterm's DOM renderer draws as a 1px border. */
const BASE_THICKNESS_WORLD = 1

/**
 * The overlay rects for a shape, in fractions of ONE cell's units.
 *
 * `block` and `none` return `[]`: the first is drawn by the cell path (see the module comment) and
 * the second draws nothing at all. An empty list is the caller's signal to skip the whole pass, so a
 * degenerate cell or a zero thickness costs zero GL calls rather than a draw of no pixels.
 *
 * THE CORNERS ARE WRITTEN ONCE. The verticals are inset by the horizontals' thickness rather than
 * running the full height, so no two rects of an `outline` overlap. It costs nothing today — the
 * cursor colour is opaque — and it is what keeps the shape correct the moment anything translucent
 * is drawn through this path (a blink fade, a themed cursor with alpha): two overlapping rects put
 * twice the alpha on each corner, which reads as four bright dots around the cell.
 *
 * CLAMPED, because the thickness is derived from the CAMERA (`cursorThicknessWorld`) while the cell
 * comes from the font: zoomed far enough out, one device pixel is thicker than the whole cell. An
 * unclamped underline would sit at a negative `y` and an unclamped outline's verticals would have
 * negative height — a rect that either vanishes or paints a stripe across the row.
 */
export function cursorOverlays(
  shape: CursorShape,
  widthCells: number,
  thicknessPx: number,
  cellW: number,
  cellH: number
): CursorOverlay[] {
  if (shape === 'block' || shape === 'none') return []
  // Guarded rather than trusted: these arrive from a live camera and a live font measurement, and a
  // NaN here would propagate into the vertex positions of the draw call it lands in.
  if (!(thicknessPx > 0) || !(cellW > 0) || !(cellH > 0)) return []
  const span = cellW * (widthCells >= 2 ? 2 : 1)

  if (shape === 'bar') {
    // The bar marks the INSERTION POINT — the left edge of the cell, whatever glyph sits there — so
    // it is one thickness wide even on a wide glyph, where widening it with the cell would draw a
    // half-block over every CJK character.
    return [{ x: 0, y: 0, w: Math.min(thicknessPx, span), h: cellH }]
  }
  if (shape === 'underline') {
    const h = Math.min(thicknessPx, cellH)
    return [{ x: 0, y: cellH - h, w: span, h }]
  }
  // outline — the hollow box a blurred terminal draws.
  const th = Math.min(thicknessPx, cellH / 2)
  const tv = Math.min(thicknessPx, span / 2)
  const innerH = cellH - 2 * th
  const rects: CursorOverlay[] = [
    { x: 0, y: 0, w: span, h: th },
    { x: 0, y: cellH - th, w: span, h: th }
  ]
  // Dropped rather than emitted with zero height: at a thickness of half the cell the two
  // horizontals already meet, and a rect of no area is a draw the GPU does nothing with.
  if (innerH > 0 && tv > 0) {
    rects.push({ x: 0, y: th, w: tv, h: innerH })
    rects.push({ x: span - tv, y: th, w: tv, h: innerH })
  }
  return rects
}

/**
 * Which shape a terminal's cursor takes, from xterm's two options and the focus flag.
 *
 * The options arrive as plain strings — this module never imports xterm — and an UNKNOWN one
 * degrades to the default for that focus state rather than to `none`: the values come from settings
 * on disk, and a typo must cost the user their chosen shape, never their cursor.
 *
 * The row worth stating: xterm's DEFAULT `cursorInactiveStyle` is `outline`, the hollow box a
 * blurred terminal draws. That is the shape limitation L2 said this engine could not express, so
 * the DEFAULT path is the one this whole task exists to light up — not an exotic setting.
 *
 * `outline` and `none` are deliberately NOT accepted for a focused terminal: xterm's `cursorStyle`
 * has no such members, and honouring them would let a settings typo hollow out (or extinguish) the
 * cursor of the terminal the user is typing into.
 */
export function resolveCursorShape(
  focused: boolean,
  style: string | undefined,
  inactiveStyle: string | undefined
): CursorShape {
  if (focused) {
    // A switch, not a lookup table: `style` is an arbitrary string from disk, and indexing an object
    // with it can answer inherited members ('constructor') as readily as own ones.
    switch (style) {
      case 'bar':
        return 'bar'
      case 'underline':
        return 'underline'
      default:
        return 'block'
    }
  }
  switch (inactiveStyle) {
    case 'block':
      return 'block'
    case 'bar':
      return 'bar'
    case 'underline':
      return 'underline'
    case 'none':
      return 'none'
    default:
      return 'outline'
  }
}

/**
 * The hairline's thickness in WORLD units (CSS px at zoom 1), for a camera.
 *
 * One CSS pixel is the mark every other renderer draws — xterm's DOM renderer uses a 1px border,
 * and its canvas renderers scale with the same CSS transform this canvas does. The floor is the
 * addition: `1 / (zoom * dpr)` is one DEVICE pixel expressed in world units, and a line thinner than
 * that lands between sampled pixels — the cursor fades out exactly as the user zooms away from the
 * terminal they are looking for. Taking the max keeps it at a CSS pixel while zoomed in (where the
 * device pixel is the smaller number) and holds it at a device pixel once zoomed out past 1:1.
 *
 * A degenerate camera (zoom or dpr 0/NaN — a half-initialized context) answers the base thickness
 * rather than Infinity or NaN, either of which would poison the rects computed from it.
 */
export function cursorThicknessWorld(zoom: number, dpr: number): number {
  const scale = zoom * dpr
  if (!(scale > 0) || !Number.isFinite(scale)) return BASE_THICKNESS_WORLD
  return Math.max(BASE_THICKNESS_WORLD, 1 / scale)
}
