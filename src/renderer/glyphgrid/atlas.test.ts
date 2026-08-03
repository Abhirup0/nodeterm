import { describe, expect, it } from 'vitest'
import { GlyphAtlas, type GlyphRasterizer } from './atlas'

function fakeRasterizer(cellW = 10, cellH = 20): GlyphRasterizer & { calls: string[] } {
  const calls: string[] = []
  return {
    cellW,
    cellH,
    calls,
    source: null,
    draw(code, bold, italic, x, y) {
      calls.push(`${code}|${bold ? 'b' : ''}${italic ? 'i' : ''}@${x},${y}`)
    }
  }
}

describe('GlyphAtlas', () => {
  it('slot 0 is blank and never rasterized; first real glyph gets slot 1', () => {
    const r = fakeRasterizer()
    const atlas = new GlyphAtlas(r, 100)
    expect(atlas.glyphFor(0x20, false, false)).toBe(0) // space = blank slot, no draw
    expect(r.calls).toEqual([])
    expect(atlas.glyphFor(0x41, false, false)).toBe(1) // 'A'
    expect(r.calls).toHaveLength(1)
  })

  it('same key is cached (one rasterization, stable slot); styles are distinct keys', () => {
    const r = fakeRasterizer()
    const atlas = new GlyphAtlas(r, 100)
    const a = atlas.glyphFor(0x41, false, false)
    expect(atlas.glyphFor(0x41, false, false)).toBe(a)
    expect(atlas.glyphFor(0x41, true, false)).not.toBe(a)
    expect(r.calls).toHaveLength(2)
  })

  it('lays slots out row-major within the page and reports correct uv rects', () => {
    const r = fakeRasterizer(10, 20) // 100px page → 10 cols × 5 rows
    const atlas = new GlyphAtlas(r, 100)
    for (let i = 0; i < 11; i++) atlas.glyphFor(0x30 + i, false, false) // '0'..':' fills into row 2
    // The i-th glyph lands in slot i+1 (slot 0 is blank), so calls[9] is '9' (0x39) in slot 10.
    // slot 10 = row 1, col 0 → x=0, y=20; slot 11 = row 1, col 1 → x=10, y=20.
    expect(r.calls[8]).toBe(`${0x38}|@90,0`) // slot 9 = last cell of row 0
    expect(r.calls[9]).toBe(`${0x39}|@0,20`)
    expect(r.calls[10]).toBe(`${0x3a}|@10,20`)
    const rect = atlas.slotRect(1)
    expect(rect).toEqual({ u0: 0.1, v0: 0, u1: 0.2, v1: 0.2 })
  })

  it('slotRect is correct past row 0', () => {
    const atlas = new GlyphAtlas(fakeRasterizer(10, 20), 100) // 10 cols × 5 rows
    expect(atlas.slotRect(10)).toEqual({ u0: 0, v0: 0.2, u1: 0.1, v1: 0.4 })
  })

  // What this pins, exactly: `slotRect` against a HAND-TRANSCRIBED copy of gl-webgl2's vertex
  // shader formula — cols = floor(sizePx/strideX), cellUv = [cellW/sizePx, cellH/sizePx],
  // strideUv = [strideX/sizePx, strideY/sizePx], slotOrigin = (slot % cols, floor(slot / cols)) *
  // strideUv (see `uAtlasCols` / `uAtlasCell` / `uAtlasStride` in VERT). So it catches a change to
  // the CPU side (atlas padding, page metrics, slot ordering) — and nothing else.
  //
  // Every number on the shader side is computed HERE, from the cell the rasterizer was built with
  // — never read back off the atlas. Deriving `cols` from `atlas.strideX` would make the test
  // agree with whatever the atlas decided, including conflating the pitch with the extent.
  //
  // It is NOT a tie to the live GLSL: the shader side below is this test's own copy, so editing
  // the real shader leaves this green, and `slotRect` currently has no production caller at all
  // (the shader derives its uvs itself from the uniforms). The actual tie — a visual pass, or
  // pinning the GLSL against a generated line — is owed to Phase 1b.
  //
  // Run over an integer cell AND a fractional one: an integer cell has stride === extent, so it
  // alone cannot tell a pitch/extent conflation from a correct derivation.
  it.each([
    { label: 'integer cell (stride === extent)', cellW: 10, cellH: 20, sizePx: 100 },
    { label: 'fractional device cell (13px font at dpr 2)', cellW: 15.66, cellH: 31.2, sizePx: 512 }
  ])('slotRect agrees with the shader uv derivation for every interesting slot — $label', ({
    cellW,
    cellH,
    sizePx
  }) => {
    const atlas = new GlyphAtlas(fakeRasterizer(cellW, cellH), sizePx)
    const strideX = Math.ceil(cellW)
    const strideY = Math.ceil(cellH)
    const cols = Math.floor(sizePx / strideX)
    const rows = Math.floor(sizePx / strideY)
    const cellUv = [cellW / sizePx, cellH / sizePx]
    const strideUv = [strideX / sizePx, strideY / sizePx]
    for (const slot of [0, 1, cols - 1, cols, cols + 1, cols * rows - 1]) {
      const u0 = (slot % cols) * strideUv[0]
      const v0 = Math.floor(slot / cols) * strideUv[1]
      expect(atlas.slotRect(slot)).toEqual({ u0, v0, u1: u0 + cellUv[0], v1: v0 + cellUv[1] })
    }
  })

  // The defect this split exists for: the atlas used to be built from its OWN `measureText`
  // metrics, rounded up to whole texels, while the grid draws each cell at xterm's exact device
  // cell — so every glyph was stretched over a quad a couple of percent smaller than its bitmap
  // and resampled ("rougher than the DOM renderer"). Now the sampled EXTENT is the exact
  // (fractional) cell and only the slot PITCH rounds.
  describe('fractional device cells (xterm reports charWidth * dpr, which is not an integer)', () => {
    it('keeps the sampled extent exact and rounds only the slot pitch', () => {
      const atlas = new GlyphAtlas(fakeRasterizer(15.66, 31), 2048)
      expect(atlas.cellW).toBe(15.66) // extent: unrounded, so texel:pixel is 1:1 at zoom 1
      expect(atlas.strideX).toBe(16) // pitch: whole texels
      expect(atlas.cellH).toBe(31)
      expect(atlas.strideY).toBe(31)
      const rect = atlas.slotRect(1)
      expect(rect.u1 - rect.u0).toBeCloseTo(15.66 / 2048, 12)
      expect(rect.u0).toBeCloseTo(16 / 2048, 12) // …starting on a texel boundary
    })

    it('lays slots out on the pitch, so no two glyphs share a boundary texel', () => {
      const r = fakeRasterizer(15.66, 31)
      const atlas = new GlyphAtlas(r, 2048)
      atlas.glyphFor(0x41, false, false) // slot 1
      atlas.glyphFor(0x42, false, false) // slot 2
      expect(r.calls[0]).toBe(`${0x41}|@16,0`)
      expect(r.calls[1]).toBe(`${0x42}|@32,0`)
    })

    it('counts capacity in whole pitches — the gutter is not usable area', () => {
      // floor(100/16) = 6 cols, floor(100/31) = 3 rows.
      expect(new GlyphAtlas(fakeRasterizer(15.66, 31), 100).capacity).toBe(18)
    })

    it('a sub-texel cell still yields a finite pitch rather than an infinite capacity', () => {
      const atlas = new GlyphAtlas(fakeRasterizer(0.4, 0.4), 100)
      expect(atlas.strideX).toBe(1)
      expect(atlas.capacity).toBe(10000)
    })
  })

  it('a degenerate page (sizePx < cellW) yields blank slots and a zero rect, never NaN', () => {
    const atlas = new GlyphAtlas(fakeRasterizer(10, 20), 5)
    expect(atlas.capacity).toBe(0)
    expect(atlas.glyphFor(0x41, false, false)).toBe(0)
    expect(atlas.slotRect(0)).toEqual({ u0: 0, v0: 0, u1: 0, v1: 0 })
  })

  it('sets dirty on new glyphs and clears on demand', () => {
    const atlas = new GlyphAtlas(fakeRasterizer(), 100)
    expect(atlas.dirty).toBe(false)
    atlas.glyphFor(0x41, false, false)
    expect(atlas.dirty).toBe(true)
    atlas.clearDirty()
    expect(atlas.dirty).toBe(false)
  })

  it('a full page falls back to the blank slot instead of overflowing', () => {
    const r = fakeRasterizer(10, 20)
    const atlas = new GlyphAtlas(r, 20) // 2 cols × 1 row = capacity 2 (slot 0 blank + 1 real)
    expect(atlas.capacity).toBe(2)
    expect(atlas.glyphFor(0x41, false, false)).toBe(1)
    expect(atlas.glyphFor(0x42, false, false)).toBe(0) // full → blank, never throws
  })
})
