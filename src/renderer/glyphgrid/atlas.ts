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
  private nextSlot = 1 // slot 0 is permanently blank
  private dirtyFlag = false

  constructor(
    private rasterizer: GlyphRasterizer,
    private pageSizePx = 1024
  ) {}

  /** The three metrics `GlyphGL.uploadAtlas` needs to map a slot index to texels. They are
   *  passthroughs on purpose: the page size is the atlas's own, the cell size belongs to the
   *  rasterizer that filled it, and the engine must never have to know a second source for
   *  either — a mismatch here shifts every glyph by a fraction of a cell. */
  get sizePx(): number {
    return this.pageSizePx
  }
  get cellW(): number {
    return this.rasterizer.cellW
  }
  get cellH(): number {
    return this.rasterizer.cellH
  }

  get capacity(): number {
    const cols = Math.floor(this.sizePx / this.rasterizer.cellW)
    const rows = Math.floor(this.sizePx / this.rasterizer.cellH)
    return cols * rows
  }

  glyphFor(code: number, bold: boolean, italic: boolean): number {
    if (code === 0x20 || code === 0) return 0
    const key = `${code}|${bold ? 1 : 0}${italic ? 1 : 0}`
    const hit = this.slots.get(key)
    if (hit !== undefined) return hit
    if (this.nextSlot >= this.capacity) return 0 // page full — degrade to blank, never throw
    const slot = this.nextSlot++
    const cols = Math.floor(this.sizePx / this.rasterizer.cellW)
    const x = (slot % cols) * this.rasterizer.cellW
    const y = Math.floor(slot / cols) * this.rasterizer.cellH
    this.rasterizer.draw(code, bold, italic, x, y)
    this.slots.set(key, slot)
    this.dirtyFlag = true
    return slot
  }

  slotRect(slot: number): { u0: number; v0: number; u1: number; v1: number } {
    const cols = Math.floor(this.sizePx / this.rasterizer.cellW)
    const x = (slot % cols) * this.rasterizer.cellW
    const y = Math.floor(slot / cols) * this.rasterizer.cellH
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
