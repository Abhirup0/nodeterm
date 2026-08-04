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

/** The two states a texel of this atlas can be in. Coverage is the LUMINANCE of the page, read off
 *  the red channel in the shader — so "no ink" must be opaque BLACK, not transparency. */
const INK_OFF = '#000000'
const INK_ON = '#ffffff'

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
 *
 * WHY NOT xterm's CONVENTION (checked in round 6, deliberately left alone). The WebglAddon's
 * `_drawToCache` sets `textBaseline = TEXT_BASELINE` (`'ideographic'`, `'bottom'` on Firefox) and
 * draws at `y = padding + deviceCharHeight` — i.e. the bottom of the char box is pinned to the
 * char height and any extra `lineHeight` leading falls entirely BELOW the glyph. Two reasons ours
 * stays as it is:
 *   - At the default `lineHeight: 1` the two agree to within rounding. `deviceCharHeight` is the
 *     measured line box (`ceil(charSize.height * dpr)`, DomRenderer `_updateDimensions`), so
 *     `cellH ≈ asc + desc`, the half-leading term collapses to ~0 and our baseline lands on `asc`
 *     — the same row xterm's ideographic-at-cell-bottom resolves to.
 *   - Both land on a WHOLE device pixel: xterm's `deviceCharHeight` is `ceil`'d, ours is
 *     `Math.round`'d. Sharpness is what a fractional baseline would cost (the atlas is sampled 1:1
 *     with NEAREST, so a half-texel of vertical ink offset is a different cut per glyph); an
 *     integer baseline has no such cost, and any residual disagreement is ≤0.5px of PLACEMENT, not
 *     of crispness.
 * Where they genuinely differ (`lineHeight != 1`) the half-leading answer is the one that matches
 * the DOM renderer these terminals fall back to, so it is the one worth keeping.
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

/** Draws WHITE glyphs on an OPAQUE BLACK page (the shader tints); baseline-centered in the cell
 *  like xterm's renderers. Returns null when OffscreenCanvas 2D is unavailable — caller keeps the
 *  DOM renderer.
 *
 *  WHY THE PAGE IS OPAQUE (round 6 — "plain text is still softer than the WebglAddon"): macOS
 *  rasterizes text drawn onto a TRANSPARENT backdrop thinner and softer than the same text drawn
 *  over an opaque one. xterm's own TextureAtlas never rasterizes onto transparency — read
 *  `_drawToCache` in @xterm/addon-webgl: before every `fillText` it does
 *  `globalCompositeOperation='copy'; fillStyle=backgroundColor.css; fillRect(0,0,w,h)`, i.e. it
 *  hands the platform a fully painted backdrop, and only AFTERWARDS (`clearColor`, on the read-back
 *  ImageData) does it punch the background pixels' alpha to 0. Our atlas is monochrome + tinted in
 *  the shader rather than color-keyed, so we get the same input to the rasterizer the cheap way:
 *  the page is black, the ink is white, and COVERAGE IS THE LUMINANCE — read off the RED channel
 *  by the fragment shader (`gl-webgl2.ts`). The alpha channel is now 1 everywhere and unused.
 *
 *  The context is deliberately still `alpha: true` — exactly like xterm's tmp canvas, which is a
 *  plain `document.createElement('canvas')`. The opacity that matters is the PAINTED backdrop, not
 *  the backing store's format, and an alpha-less canvas would additionally let Chromium turn on
 *  LCD/subpixel antialiasing, whose per-channel coverage would make sampling one channel wrong.
 *
 *  Three invariants this file must not break:
 *  1. The page is opaque BLACK where no glyph has been drawn — coverage 0. The atlas's slot 0
 *     (the cell at 0,0) is permanently blank and is what every space/unknown glyph samples;
 *     `GlyphAtlas` never asks for slot 0, so slot 0 is never drawn and simply stays black.
 *  2. A slot is re-blacked (not cleared to transparency) before it is drawn, so evicting and
 *     reusing a cell can never leave a previous glyph's ink behind as coverage.
 *  3. Every draw is CLIPPED to its cell rect, so a glyph wider than cellW (a CJK cell, an
 *     overhanging italic) cannot bleed into the neighbouring slot's texels — and the per-slot
 *     black fill above is clipped by the same rect, so it can never erase a neighbour.
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
  // The backdrop, once, for the whole page: every texel starts at coverage 0 AND opaque, which is
  // what gives the platform rasterizer something to draw over (see the header).
  ctx.fillStyle = INK_OFF
  ctx.fillRect(0, 0, atlasSizePx, atlasSizePx)
  const baseline = baselineIn(ctx, font)
  return {
    cellW: font.cellW,
    cellH: font.cellH,
    get source() {
      return canvas
    },
    /** T2 fills this in: blank the page back to the state `createCanvasRasterizer` leaves it in.
     *  Kept mechanical here — the atlas's reset path needs the member to exist, and the colour
     *  contract (transparent-black page, per-slot backdrops) is Task 2's to land. */
    clearPage() {
      ctx.fillStyle = INK_OFF
      ctx.fillRect(0, 0, atlasSizePx, atlasSizePx)
    },
    // fg/bg are the FINAL packed colour lanes for this slot. T2 fills this in: fill the whole
    // PITCH rect (gutter included) with `bg` and paint the glyph/box ops in `fg`, so the atlas
    // holds CoreText's own coloured pixels. Until then the draw stays monochrome — the signature
    // is threaded now because the atlas keys on the colours from this task on.
    draw(code, bold, italic, x, y, _fg, _bg) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, y, font.cellW, font.cellH)
      ctx.clip()
      // Re-black this slot only (the clip keeps it off the neighbours): drawing over a reused cell
      // must start from coverage 0, and 'source-over' white ink cannot subtract old ink.
      ctx.fillStyle = INK_OFF
      ctx.fillRect(x, y, font.cellW, font.cellH)
      ctx.fillStyle = INK_ON
      // Geometry first: these ranges are DEFINED as fractions of the cell, so drawing them is
      // both more correct and cheaper than trusting the face. The ops are already snapped to
      // device px (interior edges) and to the exact cell bounds (outer edges), so no seam can
      // appear between two adjacent cells and no rect lands on a half pixel.
      // The ops are opaque white by construction — including the shade blocks, which are DITHER
      // patterns rather than tints, so `globalAlpha` is never touched here and the atlas keeps
      // exactly two states per texel: white ink (coverage 1) or the black backdrop (coverage 0).
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
