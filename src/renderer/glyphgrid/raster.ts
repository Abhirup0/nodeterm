import type { GlyphRasterizer } from './atlas'

export interface RasterFont {
  family: string
  sizePx: number
  cellW: number
  cellH: number
}

/** Draws WHITE glyphs (the shader tints); baseline-centered in the cell like xterm's renderers.
 *  Returns null when OffscreenCanvas 2D is unavailable — caller keeps the DOM renderer.
 *
 *  Two invariants this file must not break:
 *  1. The canvas is left fully TRANSPARENT except where a glyph is drawn — the atlas's slot 0
 *     (the cell at 0,0) is permanently blank and is what every space/unknown glyph samples. So
 *     never clear/fill the canvas here: GlyphAtlas never asks for slot 0, and a fill would put
 *     ink under it.
 *  2. Every draw is CLIPPED to its cell rect, so a glyph wider than cellW (a CJK cell, an
 *     overhanging italic) cannot bleed into the neighbouring slot's texels. */
export function createCanvasRasterizer(
  font: RasterFont,
  atlasSizePx: number
): GlyphRasterizer | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  const canvas = new OffscreenCanvas(atlasSizePx, atlasSizePx)
  const ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return null
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = '#ffffff'
  const baseline = Math.round(font.cellH * 0.8) // near xterm's metric; harness-verified
  return {
    cellW: font.cellW,
    cellH: font.cellH,
    get source() {
      return canvas
    },
    draw(code, bold, italic, x, y) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, y, font.cellW, font.cellH)
      ctx.clip()
      ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${font.sizePx}px ${font.family}`
      ctx.fillText(String.fromCodePoint(code), x, y + baseline)
      ctx.restore()
    }
  }
}
