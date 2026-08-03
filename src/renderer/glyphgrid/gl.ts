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
  /** packColor() — the opaque plate drawn BEFORE this grid's cells, covering the grid rect
   *  expanded by `padPx` on every side. This is the Phase-1 occlusion story: painter's order
   *  makes it cover anything drawn beneath it (overlapping terminals), and it fills the node
   *  body's padding around the character matrix. */
  bgColor: number
  /** Plate padding around the grid rect, in WORLD units (scaled by the camera zoom like any
   *  other world length). */
  padPx: number
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
  /** Draws the plate (a scissored clear of the padded grid rect) and then the instanced cells
   *  from the grid's OWN buffer, in call order (painter's algorithm). */
  drawGrid(g: GridDrawParams): void
  endFrame(): void
  dispose(): void
}
