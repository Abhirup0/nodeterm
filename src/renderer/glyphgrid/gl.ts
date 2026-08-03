import type { Camera } from './camera'

/** One grid submitted for drawing: the packed cell buffer plus where/how big it sits in world
 *  space. `cells` is laid out exactly as cells.ts writes it (cols*rows*CELL_STRIDE uint32
 *  lanes, [glyph, fg, bg, flags]) — the GL implementation binds those lanes as instanced
 *  vertex attributes, so the two files change together. */
export interface GridDraw {
  /** cols*rows*CELL_STRIDE uint32 lanes, layout per cells.ts */
  cells: Uint32Array
  cols: number
  rows: number
  /** cell size in world units (CSS px at zoom 1) */
  cellW: number
  cellH: number
  /** world position of the grid's top-left corner */
  originX: number
  originY: number
  /** packColor() — the opaque background quad (occlusion!). See the note in gl-webgl2.ts's
   *  drawGrid: Phase 0 paints each cell's own bg in the fragment shader, so this field is
   *  accepted but only CONSUMED IN PHASE 1 (padding/borders around the grid). */
  bgColor: number
}

/** Everything engine.ts is allowed to know about the GPU. Draw order is the painter's
 *  algorithm: the engine calls drawGrid back-to-front and each grid's opaque background
 *  occludes what was drawn beneath it — that is how overlapping terminals will occlude each
 *  other in Phase 1 without any depth buffer. */
export interface GlyphGL {
  /** w/h in CSS px, dpr the device pixel ratio — sizes the backing store and the viewport. */
  resize(w: number, h: number, dpr: number): void
  uploadAtlas(source: TexImageSource, sizePx: number, cellW: number, cellH: number): void
  /** Clears the frame and sets the camera uniforms. */
  beginFrame(camera: Camera): void
  /** Draws the instanced cells in call order. Phase 0 paints each cell's own bg lane; the
   *  separate bgColor plate lands in Phase 1 — see gl-webgl2.ts drawGrid. */
  drawGrid(g: GridDraw): void
  endFrame(): void
  dispose(): void
}
