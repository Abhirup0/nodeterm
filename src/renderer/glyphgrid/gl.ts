import type { Camera } from './camera'
import type { GridCursor } from './cursor'

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
  /**
   * The plate's corner radius in WORLD units (CSS px at zoom 1). **0 = a square rect**, which is
   * exactly the shape the plate had when it was a scissored `clear`, so a caller that says nothing
   * gets the pre-Phase-2 rectangle bit for bit.
   *
   * WHY THE PLATE HAS TO CARRY ONE. The plate is a node BODY (see `plateX`) and a node has
   * `border-radius`; the shared canvas is not a DOM child of that node, so nothing can clip it to
   * the node's shape. A square plate under a rounded node is what made every shared terminal's
   * corners read square against its own chrome (limitation L4).
   *
   * WHICH CORNERS ARE ROUNDED IS PART OF THIS CONTRACT: the BOTTOM two, never the top. The plate
   * rect is the node's body, which is the node's LAST child — its bottom edge is the node's own
   * bottom (rounded, and behind it nothing but canvas), while its top edge is an interior seam
   * against opaque chrome (the header, the labels row, the find bar). Rounding the top corners
   * would not shape a visible corner at all; it would UNCOVER two wedges of body that nothing else
   * paints, which is a new artifact rather than a fixed one. See PLATE_FRAG in gl-webgl2.ts.
   *
   * Scaling and clamping are the implementation's job, per draw (`plateRadiusDevice`): both inputs
   * — the camera and the plate's device extent — are known only at draw time.
   */
  plateRadius: number
  /**
   * The cursor to draw OVER this grid's cells, or null for none.
   *
   * Only the shapes that are not a block ever arrive here: a block cursor is a CELL REWRITE (the
   * feed swaps the cell's colours, which is the only way to invert the glyph under it), so the cell
   * data already carries it and an overlay would paint an opaque quad over the inversion. See
   * `cursor.ts` — `cursorOverlays` answers `[]` for `block` for the same reason.
   *
   * The GEOMETRY is not carried: the rects depend on the camera (a hairline is defined in device
   * pixels), so the implementation derives them per draw from `cursor.ts`'s pure functions rather
   * than having the engine recompute a spec on every zoom tick.
   */
  cursor: GridCursor | null
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
  /** Draws the plate (an opaque rounded quad over the grid's PLATE rect), then the instanced cells
   *  from the grid's OWN buffer, then the cursor overlay if it has one — in call order (painter's
   *  algorithm), so a grid drawn later covers all three. */
  drawGrid(g: GridDrawParams): void
  endFrame(): void
  /**
   * Rebuild every GPU object this layer owns, after the drawing context was LOST and the browser
   * gave it back (`webglcontextrestored`). Programs, the atlas texture and every piece of cached
   * GL state die with a context; the objects that replace them are new, so nothing may be reused
   * across the boundary — locations, filter caches and the current program included.
   *
   * It does NOT recreate the per-grid buffers: only the engine knows which grids exist and how
   * large they are, so it re-creates them itself right after this returns (`reviveGpu`). What this
   * does promise is that the grid table is EMPTY afterwards, so those `createGrid` calls allocate
   * rather than trying to free buffers that the lost context already took.
   *
   * **Throws when the rebuild fails** (a driver that will not compile the cell program against the
   * fresh context). That is deliberately the same shape as `createWebgl2GL` returning null — the
   * caller's only correct answer is a permanent fallback to the DOM renderer, and a half-built
   * context that silently draws nothing would be indistinguishable from a frozen canvas.
   */
  restore(): void
  dispose(): void
}
