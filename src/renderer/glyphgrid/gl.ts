import type { Camera } from './camera'

/** Per-draw parameters for one grid: where/how big it sits in world space, plus the plate.
 *
 *  Cell DATA deliberately does NOT travel here — it lives in the grid's own GPU buffer, created
 *  by `createGrid` and updated by `uploadRows`. Phase 0 re-sent every visible grid's whole cell
 *  array on any change (~90 MB/s under the Phase-1b load of one busy terminal among fifty); the
 *  per-grid buffer means a change costs exactly the rows that changed.
 *
 *  Index mapping, unchanged and shared with cells.ts: `cellIndex = row * cols + col`, each cell
 *  CELL_STRIDE uint32 lanes ([glyph slot, fg, bg, flags]). The GL implementation binds those
 *  lanes as instanced vertex attributes, so the two files change together. */
export interface GridDrawParams {
  id: string
  cols: number
  rows: number
  /** cell size in world units (CSS px at zoom 1) */
  cellW: number
  cellH: number
  /** world position of the grid's top-left corner */
  originX: number
  originY: number
  /** packColor() — the colour the plate is cleared to. This is the Phase-1 occlusion story:
   *  painter's order makes the plate cover anything drawn beneath it (overlapping terminals). */
  bgColor: number
  /**
   * The PLATE rect in WORLD units (top-left origin, like `originX/originY`): the opaque ground
   * this terminal paints under itself — the transparent DOM window's FULL area, i.e. the node
   * body rect, not the character matrix.
   *
   * The grid may be (and normally is) SMALLER than this: a body's height/width are not exact
   * cell multiples, so xterm letterboxes the remainder, and in shared mode nothing else paints
   * that remainder — the node body is transparent. A plate sized to the grid therefore left a
   * band of raw canvas at the bottom and right of every terminal. The plate is an INDEPENDENT
   * rect for exactly that reason; painter's order still applies to it unchanged (plate first,
   * then this grid's cells, then whatever is drawn above).
   */
  plateX: number
  plateY: number
  plateW: number
  plateH: number
}

/** Everything engine.ts is allowed to know about the GPU. Draw order is the painter's
 *  algorithm: the engine calls drawGrid back-to-front and each grid's opaque plate occludes
 *  what was drawn beneath it — that is how overlapping terminals occlude each other without
 *  any depth buffer. */
export interface GlyphGL {
  /** w/h in CSS px, dpr the device pixel ratio — sizes the backing store and the viewport. */
  resize(w: number, h: number, dpr: number): void
  /** `cellW/cellH` are the SAMPLED extent of a slot (the exact device cell, fractional in
   *  general); `strideX/strideY` are the whole-texel slot pitch the atlas laid the page out on.
   *  They differ by under a texel and must not be conflated — see `GlyphAtlas.strideX`. */
  uploadAtlas(
    source: TexImageSource,
    sizePx: number,
    cellW: number,
    cellH: number,
    strideX: number,
    strideY: number
  ): void
  /** Allocate the grid's GPU-side cell buffer (cols*rows*CELL_STRIDE uint32s, zeroed).
   *  Re-calling with the same id REALLOCATES — that is the resize path. */
  createGrid(id: string, cols: number, rows: number): void
  disposeGrid(id: string): void
  /** Upload a contiguous row range into the grid's buffer (bufferSubData at byte offset
   *  `firstRow * cols * CELL_STRIDE * 4`). `cells.length` MUST equal
   *  `rowCount * cols * CELL_STRIDE` — a mismatch would scribble across neighbouring rows, so
   *  it throws rather than truncating. */
  uploadRows(
    id: string,
    firstRow: number,
    rowCount: number,
    cols: number,
    cells: Uint32Array
  ): void
  /** Clears the frame and sets the camera uniforms. */
  beginFrame(camera: Camera): void
  /** Draws the plate (a scissored clear of the grid's PLATE rect) and then the instanced cells
   *  from the grid's OWN buffer, in call order (painter's algorithm). */
  drawGrid(g: GridDrawParams): void
  endFrame(): void
  dispose(): void
}
