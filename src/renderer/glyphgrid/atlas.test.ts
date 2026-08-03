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
