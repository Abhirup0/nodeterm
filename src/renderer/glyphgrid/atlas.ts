/** Monochrome glyph atlas BOOKKEEPING. Rasterization is injected (GlyphRasterizer) so this
 *  module is pure and unit-testable; the real rasterizer (raster.ts) draws white glyphs onto an
 *  OffscreenCanvas that gl-webgl2.ts uploads as the atlas texture. Colors are per-cell instance
 *  data tinted in the shader — that is what keeps the key space to code|bold|italic. */
export interface GlyphRasterizer {
  cellW: number
  cellH: number
  draw(code: number, bold: boolean, italic: boolean, x: number, y: number): void
  readonly source: TexImageSource | null
}

export class GlyphAtlas {
  private slots = new Map<string, number>()
  /** Slot 0 is permanently blank and is never handed to the rasterizer: every space, every
   *  unknown code point and every cell of a not-yet-uploaded GPU buffer samples it. Its
   *  BLANKNESS is a contract on raster.ts — the page is opaque BLACK (= coverage 0; ink is white
   *  and the shader reads the luminance) and nothing may ever draw at (0,0), so slot 0 simply
   *  stays black — not something this file can enforce, so the two must change together. If ink
   *  ever lands there, every space on the canvas grows a glyph. */
  private nextSlot = 1
  private dirtyFlag = false

  constructor(
    private rasterizer: GlyphRasterizer,
    private pageSizePx = 1024
  ) {}

  /** The metrics `GlyphGL.uploadAtlas` needs to map a slot index to texels. They are
   *  passthroughs on purpose: the page size is the atlas's own, the cell size belongs to the
   *  rasterizer that filled it, and the engine must never have to know a second source for
   *  either — a mismatch here shifts every glyph by a fraction of a cell. */
  get sizePx(): number {
    return this.pageSizePx
  }
  /** The SAMPLED extent of a slot, in texels: exactly the device cell the grids draw with, which
   *  is fractional in general (xterm's `device.cell.width` is `charWidth * dpr`). Keeping it
   *  exact is what makes the texel:pixel mapping 1:1 at zoom 1 — see `strideX`. */
  get cellW(): number {
    return this.rasterizer.cellW
  }
  get cellH(): number {
    return this.rasterizer.cellH
  }

  /**
   * The slot PITCH, in whole texels — the cell rounded UP, so consecutive slots never share a
   * texel.
   *
   * Pitch and extent are separate for one reason. Rounding the CELL to whole texels (what this
   * atlas used to do) means a glyph rasterized into N texels is drawn onto a quad of N±0.5
   * device pixels: the GPU resamples every glyph by a couple of percent, which is precisely the
   * "rougher than the DOM renderer" report. Rounding only the PITCH keeps the extent exact —
   * texel:pixel 1:1 — while still starting every slot on a texel boundary, which matters because
   * a fractional origin would put two neighbouring glyphs' anti-aliasing in the SAME boundary
   * texel, and a full-block glyph would then bleed a dim column into an unrelated slot.
   *
   * The `max(1, …)` is not decoration: a pitch of 0 makes `capacity` infinite and `cellXY`'s
   * modulo NaN.
   */
  get strideX(): number {
    return Math.max(1, Math.ceil(this.rasterizer.cellW))
  }
  get strideY(): number {
    return Math.max(1, Math.ceil(this.rasterizer.cellH))
  }

  get capacity(): number {
    const cols = Math.floor(this.sizePx / this.strideX)
    const rows = Math.floor(this.sizePx / this.strideY)
    return cols * rows
  }

  /** Row-major top-left of a slot, in page PIXELS — the single copy of the layout math.
   *
   *  Both consumers must agree exactly: `glyphFor` uses it to place the ink and `slotRect` to
   *  derive the uv rect the shader samples. Two hand-written copies would drift the moment
   *  either the page metrics or the padding changed, and the symptom is every glyph rendering
   *  a fraction of a cell off — not a crash, just permanently wrong text.
   *
   *  On a DEGENERATE page (`sizePx < strideX`, so `cols === 0`) `slot % 0` is NaN, which would
   *  propagate silently into the uv rect. Capacity is 0 there, so no slot is ever allocated and
   *  the origin is simply (0,0) — the blank slot. */
  private cellXY(slot: number): { x: number; y: number } {
    const cols = Math.floor(this.sizePx / this.strideX)
    if (cols <= 0) return { x: 0, y: 0 }
    return {
      x: (slot % cols) * this.strideX,
      y: Math.floor(slot / cols) * this.strideY
    }
  }

  glyphFor(code: number, bold: boolean, italic: boolean): number {
    if (code === 0x20 || code === 0) return 0
    const key = `${code}|${bold ? 1 : 0}${italic ? 1 : 0}`
    const hit = this.slots.get(key)
    if (hit !== undefined) return hit
    // Covers the degenerate page too (capacity 0 → 1 >= 0), so nothing is ever rasterized onto a
    // page that has no room for a single cell.
    if (this.nextSlot >= this.capacity) return 0 // page full — degrade to blank, never throw
    const slot = this.nextSlot++
    const { x, y } = this.cellXY(slot)
    this.rasterizer.draw(code, bold, italic, x, y)
    this.slots.set(key, slot)
    this.dirtyFlag = true
    return slot
  }

  /** The uv rect of a slot: the ORIGIN follows the whole-texel pitch, the SIZE is the exact
   *  cell — the two are not the same number (see `strideX`), and the shader derives its uv the
   *  same way (`uAtlasStride` for the origin, `uAtlasCell` for the extent). */
  slotRect(slot: number): { u0: number; v0: number; u1: number; v1: number } {
    // A degenerate page has no sampleable area at all: return the ZERO rect rather than let the
    // division produce NaN, which the shader would turn into undefined texture reads.
    if (this.capacity <= 0) return { u0: 0, v0: 0, u1: 0, v1: 0 }
    const { x, y } = this.cellXY(slot)
    return {
      u0: x / this.sizePx,
      v0: y / this.sizePx,
      u1: (x + this.rasterizer.cellW) / this.sizePx,
      v1: (y + this.rasterizer.cellH) / this.sizePx
    }
  }

  get dirty(): boolean {
    return this.dirtyFlag
  }
  clearDirty(): void {
    this.dirtyFlag = false
  }
  get source(): TexImageSource | null {
    return this.rasterizer.source
  }
}
