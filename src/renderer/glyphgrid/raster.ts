import type { GlyphRasterizer } from './atlas'
import { boxGlyphOps } from './box-glyphs'

export interface RasterFont {
  family: string
  sizePx: number
  /** The cell, in DEVICE pixels — xterm's own `dimensions.device.cell`, NOT a metric measured
   *  here. Fractional widths are expected and must not be rounded on the way in: the atlas's
   *  whole-texel slot pitch is derived separately (`GlyphAtlas.strideX`), and rounding the cell
   *  is what rescales every glyph against the quad it is drawn onto. */
  cellW: number
  cellH: number
}

/**
 * Where the alphabetic baseline sits inside the cell, in device px.
 *
 * The rule a CSS line box uses — HALF-LEADING: the font's natural line box (ascent + descent) is
 * centered in the cell and the baseline falls `ascent` below that box's top. xterm's DOM renderer
 * is a stack of divs with `line-height` set to the cell height, so this is literally where its
 * glyphs land; deriving the same number is what keeps the shared renderer from drawing every row
 * a couple of pixels off from the renderer it replaces.
 *
 * `fontBoundingBox*` is optional in the spec, so the old fixed `0.8 * cellH` stays as the
 * fallback — it is within a pixel for the usual monospace faces, and a missing metric must not
 * mean "no text".
 *
 * Clamped into the cell: a font whose line box is much taller than the cell would otherwise put
 * the baseline outside the slot, and every draw is clipped to it (see below) — the glyph would
 * simply vanish.
 */
function baselineIn(ctx: OffscreenCanvasRenderingContext2D, font: RasterFont): number {
  ctx.font = `${font.sizePx}px ${font.family}`
  const m = ctx.measureText('W')
  const asc = m.fontBoundingBoxAscent
  const desc = m.fontBoundingBoxDescent
  const fallback = Math.round(font.cellH * 0.8)
  if (!Number.isFinite(asc) || !Number.isFinite(desc) || asc + desc <= 0) return fallback
  const baseline = Math.round((font.cellH - (asc + desc)) / 2 + asc)
  return Math.max(1, Math.min(Math.ceil(font.cellH), baseline))
}

/** Draws WHITE glyphs (the shader tints); baseline-centered in the cell like xterm's renderers.
 *  Returns null when OffscreenCanvas 2D is unavailable — caller keeps the DOM renderer.
 *
 *  Two invariants this file must not break:
 *  1. The canvas is left fully TRANSPARENT except where a glyph is drawn — the atlas's slot 0
 *     (the cell at 0,0) is permanently blank and is what every space/unknown glyph samples. So
 *     never clear/fill the WHOLE canvas here: GlyphAtlas never asks for slot 0, and a
 *     full-surface fill would put ink under it. A slot-granular clear (evicting one glyph to
 *     reuse its cell) is a legitimate future need and does not violate this.
 *  2. Every draw is CLIPPED to its cell rect, so a glyph wider than cellW (a CJK cell, an
 *     overhanging italic) cannot bleed into the neighbouring slot's texels.
 *
 *  And one thing it must not START doing: draw the box-drawing / block-element ranges with the
 *  FONT. `boxGlyphOps` gets first refusal on every code point (see box-glyphs.ts for why — fonts
 *  do not fill the cell, so a run of ─ came out as a dashed line and block art as a dark lattice),
 *  and `fillText` is the fallback for everything it declines. */
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
  const baseline = baselineIn(ctx, font)
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
      // Geometry first: these ranges are DEFINED as fractions of the cell, so drawing them is
      // both more correct and cheaper than trusting the face. The ops are already snapped to
      // device px (interior edges) and to the exact cell bounds (outer edges), so no seam can
      // appear between two adjacent cells and no rect lands on a half pixel.
      // The ops are opaque white by construction — including the shade blocks, which are DITHER
      // patterns rather than tints, so `globalAlpha` is never touched here and the atlas keeps
      // exactly two states per texel: ink or transparent.
      const geometry = boxGlyphOps(code, font.cellW, font.cellH)
      if (geometry) {
        for (const op of geometry) ctx.fillRect(x + op.x, y + op.y, op.w, op.h)
      } else {
        ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${font.sizePx}px ${font.family}`
        ctx.fillText(String.fromCodePoint(code), x, y + baseline)
      }
      ctx.restore()
    }
  }
}
