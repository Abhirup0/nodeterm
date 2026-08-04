import { GUTTER_PX, slotPitch, type GlyphRasterizer } from './atlas'
import { boxGlyphOps } from './box-glyphs'
import { unpackColor } from './cells'

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
 * A packed colour lane (`packColor`) as a css colour.
 *
 * ALPHA IS DROPPED, deliberately. Every lane that reaches this file has been resolved by the feed
 * into a concrete on-screen colour (default/palette/RGB → inverse → dim → selection/cursor), and
 * those all carry alpha 255 — xterm's own colour manager packs opaque colours for exactly the same
 * reason: the terminal's cells are opaque. Emitting `rgba(...)` off a lane would only matter if a
 * translucent colour ever appeared, and a translucent slot would break the invariant this file
 * exists to hold (an OPAQUE per-slot backdrop for the platform rasterizer to draw over — see the
 * header). So an unexpected alpha is ignored rather than honoured.
 *
 * `>>> 0` first: `0xff << 24` is NEGATIVE in JS, so a lane can arrive as -16777216 from an
 * arithmetic path and as 4278190080 off a cell lane. `unpackColor`'s masks happen to give the same
 * answer for both spellings, so this is not a fix for a live bug — it is the same normalization
 * `GlyphAtlas.glyphFor` applies to its KEY, kept here so the two can never disagree about what
 * "the same colour" means.
 */
function cssColor(packed: number): string {
  const { r, g, b } = unpackColor(packed >>> 0)
  return `rgb(${r},${g},${b})`
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

/** Draws each glyph in its REAL foreground colour over its REAL background — the colour-keyed
 *  atlas xterm's own TextureAtlas builds — baseline-centered in the cell like xterm's renderers.
 *  Returns null when OffscreenCanvas 2D is unavailable — caller keeps the DOM renderer.
 *
 *  THE BACKDROP, AND WHY THIS IS STILL THE ROUND-6 PROPERTY. macOS rasterizes text drawn onto a
 *  TRANSPARENT backdrop thinner and softer than the same text drawn over an opaque one, which is
 *  what made plain text look softer than the per-terminal WebglAddon. xterm never rasterizes onto
 *  transparency either — read `_drawToCache` in @xterm/addon-webgl: before every `fillText` it does
 *  `globalCompositeOperation='copy'; fillStyle=backgroundColor.css; fillRect(...)`, i.e. it hands
 *  the platform a fully painted backdrop. Round 6 approximated that with a page-wide opaque BLACK
 *  fill plus a white-ink/coverage-in-the-red-channel encoding that the shader re-mixed; that
 *  encoding is GONE (the re-mix had no correct gamma — see atlas.ts's header). The property it was
 *  protecting is not: every slot's PITCH RECT is filled with that slot's own opaque background
 *  before any ink lands, so CoreText still draws over an opaque backdrop. The page-wide black fill
 *  must NOT come back — it would put opaque black in slot 0, which every space samples.
 *
 *  The context is deliberately still `alpha: true` — exactly like xterm's tmp canvas, which is a
 *  plain `document.createElement('canvas')`. The opacity that matters is the PAINTED backdrop, not
 *  the backing store's format, and an alpha-less canvas would additionally let Chromium turn on
 *  LCD/subpixel antialiasing, whose per-channel coverage the RGBA blit would bake in per channel.
 *
 *  THE PAGE INVARIANT, in one line: every texel of a slot's PITCH rect carries content OWNED BY
 *  THAT SLOT, and no slot's content can reach another slot's texels at any level up to
 *  MAX_SAFE_LOD.
 *
 *  Stated that way on purpose — an earlier wording claimed the inter-slot page ground is "never
 *  sampled at LOD <= MAX_SAFE_LOD", which overstates it. Unallocated pitch cells DO enter a level-2
 *  texel wherever the page is not yet full: at the allocation frontier, in the page's right/bottom
 *  remainder strip, and throughout a repack that has just called `clearPage`.
 *
 *  What that looks like is NOT the background-vs-background blend GUTTER_PX's comment names, and the
 *  two must not be conflated — same accepted-residual STATUS, different visual signature. The atlas
 *  texture is NON-premultiplied (the default `UNPACK_PREMULTIPLY_ALPHA_WEBGL` is false), so a mip
 *  level averages rgb and alpha INDEPENDENTLY: an edge texel that is half opaque background and half
 *  transparent ground comes out as a HALF-BRIGHTNESS colour at HALF alpha, and the `SRC_ALPHA`
 *  blend then attenuates that already-darkened colour by that same alpha again. The result is a
 *  darker, slightly translucent rim on the outermost row/column of the affected cells at heavy
 *  zoom-out, with the node's plate showing through it — bounded, cosmetic, and self-healing as the
 *  page fills. Should the device round judge it objectionable, the escalation is to upload
 *  premultiplied (`UNPACK_PREMULTIPLY_ALPHA_WEBGL` true) and blend `ONE, ONE_MINUS_SRC_ALPHA`, which
 *  makes the average correct instead of double-counted. Device evidence first — it is not built now.
 *
 *  The promise that actually matters, and the one the LOD derivation rests on, is about INK.
 *
 *  Unpacked, the four things this file must not break:
 *  1. The page ground starts (and `clearPage` returns to) TRANSPARENT-black. The atlas's slot 0 —
 *     the pitch cell at 0,0 — is permanently blank and is what every space/unknown code point
 *     names; `GlyphAtlas` never asks for slot 0, so nothing is ever drawn there and it stays
 *     transparent. Note what that no longer buys: the shader does NOT sample slot 0 for a blank
 *     cell — it branches on the glyph LANE being 0 and paints the cell's own bg lane, which is
 *     what keeps a selection or a block cursor visible on an empty cell. Slot 0 staying blank is
 *     therefore belt-and-braces (a lane that somehow reached it draws nothing rather than a
 *     stranger's glyph) plus one real duty: it is a mip neighbour like any other slot, and ink
 *     there would bleed into slot 1's minified texels.
 *  2. A slot's whole pitch rect is REPAINTED with its background before it is inked, so reusing a
 *     cell after a reset can never leave a previous glyph's ink or a previous background behind.
 *  3. NO GLYPH DRAWS NEW GEOMETRY INTO THE GUTTER. Every glyph is clipped to the CELL rect — one
 *     gutter inside the pitch rect on each axis — so two slots' inks stay 2*GUTTER_PX texels apart,
 *     which is exactly the separation `MAX_SAFE_LOD = 2` is derived from (see GUTTER_PX in
 *     atlas.ts). A glyph wider than the cell (a CJK cell, an overhanging italic) is CUT, not
 *     allowed to overhang: a soft edge is a cosmetic loss on one glyph, a ghost glyph in a
 *     neighbour's mip is a rendering bug.
 *
 *     What the gutter then HOLDS is a separate question, and the answer changed in the 2026-08-04
 *     device round: it carries this slot's OWN EDGE-EXTENDED CONTENT — background wherever the ink
 *     does not reach the cell edge (all ordinary text, i.e. bit-identical to the old flat bg fill),
 *     the edge ink where it does (blocks, box-drawing lines, progress bars). What must never enter
 *     the gutter is a NEIGHBOUR's content, and pitch tiling still guarantees exactly that. See
 *     step 3 in `draw` for why a bg-only gutter grew a dark seam between full-bleed cells.
 *  4. The background fill covers the pitch EXACTLY — not more (it would erase a neighbour's
 *     gutter, and with it that neighbour's mip skirt) and not less (a strip of page ground inside
 *     the mip neighbourhood would blend transparency into the slot at LOD 1/2).
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
  // NOTHING is painted here. A fresh OffscreenCanvas is already transparent-black, which is the
  // page ground this atlas wants; the backdrop the platform rasterizer needs is per-slot and is
  // painted in `draw`. (Round 6's page-wide opaque black fill lived here — see the header for why
  // it must not come back.)
  const baseline = baselineIn(ctx, font)
  // The slot pitch, from the SAME helper the atlas lays the page out with — the background fill
  // below has to cover exactly one pitch cell.
  const pitchW = slotPitch(font.cellW)
  const pitchH = slotPitch(font.cellH)
  // The WHOLE texel columns/rows the cell occupies — the pitch minus its two gutters, by
  // construction (`slotPitch` is `max(1, ceil(cell)) + 2*GUTTER_PX`). The edge extension works in
  // these rather than in the fractional cell because a texel is the smallest thing it can copy,
  // and deriving them from `slotPitch`'s own expression is what keeps "cell box + two gutters ==
  // pitch" true for a sub-texel cell too.
  const colsW = Math.max(1, Math.ceil(font.cellW))
  const colsH = Math.max(1, Math.ceil(font.cellH))
  // The last FULLY COVERED texel column/row of the cell, as an offset from the ink origin — the
  // SOURCE of the far-edge replication strips (step 3 in `draw` carries the coverage table that
  // picks it). `floor(cell) - 1` is one formula for both cases: an INTEGRAL 10 gives 9, the cell's
  // last texel, identical to the `colsW - 1` it replaces; a FRACTIONAL 10.5 also gives 9, stepping
  // over texel 10 — the half-covered edge texel, whose antialiased ink/background blend is exactly
  // what must not be smeared across the whole gutter. `max(0, …)` is the sub-texel case
  // (`cell < 1` → -1): there is no fully covered texel at all, and the slot's single partial one is
  // the only thing there is to replicate.
  const lastFullCol = Math.max(0, Math.floor(font.cellW) - 1)
  const lastFullRow = Math.max(0, Math.floor(font.cellH) - 1)
  return {
    cellW: font.cellW,
    cellH: font.cellH,
    get source() {
      return canvas
    },
    /** Blank the page back to the state `createCanvasRasterizer` leaves it in: TRANSPARENT-black,
     *  everywhere. `clearRect`, not a fill — a fill of any colour would give slot 0 (and every
     *  never-allocated pitch cell) an opaque colour, and slot 0 is what every space samples. */
    clearPage() {
      ctx.clearRect(0, 0, atlasSizePx, atlasSizePx)
    },
    /** `x, y` is the INK origin the atlas hands us — already one gutter inside the pitch cell on
     *  each axis (`GlyphAtlas.cellXY`) — and `fg`/`bg` are the FINAL packed colour lanes for this
     *  slot. Two DIFFERENT rects are involved; see the header's invariants 3 and 4. */
    draw(code, bold, italic, x, y, fg, bg) {
      // 1. THE BACKGROUND, over the whole PITCH rect — gutters included. The atlas passes the INK
      //    origin, so the pitch cell's corner is one gutter back on each axis; its extent is the
      //    pitch, which is `ceil(cell) + 2*GUTTER_PX`. Both are whole texels and consecutive pitch
      //    cells are exactly `pitch` apart, so this fill tiles its own slot and touches no other.
      //    It also repaints everything a previous tenant of this slot left behind.
      //    UNCLIPPED, and the two candidate clips fail differently: a CELL clip — the one installed
      //    below for the ink — would be actively WRONG here, since it is exactly the gutter (the
      //    part of the pitch outside the cell) that has to carry this slot's own content for the
      //    mip chain to blend this slot with itself instead of with page ground. A PITCH clip
      //    would merely be REDUNDANT: the rect is already exact and `cellXY` is the only source of
      //    the origin, so there is nothing for it to catch.
      //    This is the BASE layer of the gutter, not the last word on it: step 3 replaces the parts
      //    of it that sit against ink with that ink, and leaves the rest exactly as filled here.
      ctx.fillStyle = cssColor(bg)
      ctx.fillRect(x - GUTTER_PX, y - GUTTER_PX, pitchW, pitchH)
      // 2. THE INK, clipped to the CELL rect — never the pitch rect. The cell always fits inside
      //    the pitch (the pitch rounds the cell UP and adds a gutter on each side), so no glyph can
      //    generate geometry closer than GUTTER_PX to the next slot, which is the separation
      //    MAX_SAFE_LOD = 2 is derived from. A glyph that overflows the cell is CUT here. (Step 3
      //    may then COPY this ink outward into our own gutter — a copy of our own content, never a
      //    reason to relax this clip.)
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, y, font.cellW, font.cellH)
      ctx.clip()
      ctx.fillStyle = cssColor(fg)
      // Geometry first: these ranges are DEFINED as fractions of the cell, so drawing them is
      // both more correct and cheaper than trusting the face. The ops are already snapped to
      // device px (interior edges) and to the exact cell bounds (outer edges), so no seam can
      // appear between two adjacent cells and no rect lands on a half pixel.
      // `PaintOp` is alpha-free by construction (x/y/w/h only) — including the shade blocks, which
      // are DITHER patterns rather than tints. So `globalAlpha` is never touched here and a stipple
      // reads as foreground PIXELS over the background fill, which is exactly what xterm's own
      // patterns are.
      const geometry = boxGlyphOps(code, font.cellW, font.cellH)
      if (geometry) {
        for (const op of geometry) ctx.fillRect(x + op.x, y + op.y, op.w, op.h)
      } else {
        ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${font.sizePx}px ${font.family}`
        ctx.fillText(String.fromCodePoint(code), x, y + baseline)
      }
      ctx.restore()
      // 3. THE EDGE EXTENSION — clamp-to-edge padding, the standard atlas technique. Replicate the
      //    cell's outermost texel row/column outward into the gutter, so the gutter continues the
      //    cell instead of falling back to flat background.
      //
      //    WHY (device round, 2026-08-04). The Claude mascot — solid block glyphs — grew dark
      //    "grout" lines along every cell boundary at zoom < 1, and tmux's │ ─ pane separators went
      //    dashed. The signature was exact: dips at the cell PITCH, deepest ≈ (ink+bg)/2 — a mip
      //    texel averaging cell-edge INK with the slot's bg-filled gutter. Ordinary text never
      //    showed it because its outer texels are background anyway; every glyph whose ink TOUCHES
      //    the cell edge did. GPU mode is immune because CSS downscales the COMPOSED frame, where
      //    a cell edge blends with the NEIGHBOUR'S ink rather than with per-slot background.
      //
      //    The MAX_SAFE_LOD derivation never asked the gutter to be BACKGROUND — it asks that
      //    levels 0..2 be free of the NEIGHBOUR's texels, which pitch tiling gives regardless of
      //    what this slot writes into its own gutter. So the gutter may carry this slot's edge
      //    colour, and then a minified sample at the cell edge keeps averaging ink with ink.
      //
      //    THE SAMPLED EXTENT DOES NOT CHANGE. `GlyphAtlas.slotRect` (and the shader's derivation
      //    of it) still spans exactly the cell — the extension is a mip/filter SKIRT, not extra
      //    glyph. Growing the uv rect to include the gutter would pull the padding into the glyph
      //    at zoom 1 and stretch every cell by two texels; that is a different (and wrong) change.
      //
      //    UNIFORM, never conditional: this runs for every glyph, including the ones whose ink
      //    stops short of the SOURCE texels (`lastFullCol`/`lastFullRow` on the far edges, col/row
      //    0 on the near ones) — there it copies background over background and is a visual no-op,
      //    bit-identical to what the fill in step 1 already left. A glyph whose ink reaches the
      //    last FULL texel but not the partial one beyond it (a wide bold stem on a fractional
      //    axis, say) does smear that texel's blend into a gutter that used to stay pure
      //    background — the same bounded, same-direction correction as the full-bleed case below,
      //    just smaller. Detecting "does this glyph bleed?" would cost a readback per slot and buy
      //    nothing.
      //
      //    OUTSIDE THE CLIP, deliberately: `ctx.restore()` above has dropped the CELL clip, and it
      //    would eat these strips whole — they land entirely in the gutter, which is the part of
      //    the pitch that clip exists to exclude.
      //
      //    The source is the page CANVAS ITSELF. A self-referencing `drawImage` is well-defined in
      //    2D canvas (the source region is read as a snapshot before anything is written), which is
      //    what lets the top/bottom strips below read a row the side strips have just extended.
      //
      //    FRACTIONAL CELLS — why the far-edge strips source `lastFullCol`/`lastFullRow` rather
      //    than the cell's outermost texel. A device cell is `charWidth * dpr` and is fractional in
      //    general, so its outer edge falls INSIDE a texel: that texel is only partially covered by
      //    the cell, and the rasterizer leaves it as an antialiased blend of ink and background
      //    (0.5 ink on a .5 cell). It is genuine cell content and STAYS exactly where it is — the
      //    question is only what the GUTTER beside it should continue.
      //
      //    Take a full-bleed cell (ink = 1, background = 0) with a .5-fractional width, and read
      //    off the level-2 block that straddles the boundary — four columns: the last full column,
      //    the half-covered edge texel, and the two gutter texels:
      //
      //      gutter holds            block                average   dip vs solid ink
      //      ─────────────────────── ──────────────────── ───────── ────────────────
      //      background (before)     1, 0.5, 0,   0         37.5%      62.5 pts
      //      the PARTIAL texel       1, 0.5, 0.5, 0.5      62.5%      37.5 pts
      //      the last FULL texel     1, 0.5, 1,   1        87.5%      12.5 pts
      //
      //    Replicating the partial texel is not wrong — it is still this slot's own edge colour —
      //    but it carries the half-coverage outward and leaves a visibly reduced grout dip on that
      //    axis. Sourcing one texel further in is what a COMPOSED-frame downscale would see: the
      //    neighbouring cell's ink begins mid-texel, so beyond the boundary the colour is solidly
      //    the neighbour's, not a fade to background.
      //
      //    RESIDUAL, stated so nobody hunts for it: 12.5 points, from the partial texel itself,
      //    which no gutter content can cancel — it belongs to the cell. Only an axis whose device
      //    cell extent is fractional has it at all.
      const prevSmoothing = ctx.imageSmoothingEnabled
      // A 1-texel source stretched over GUTTER_PX texels must REPLICATE, not resample: with
      // smoothing on the copy would fade back towards whatever the gutter held, which is the
      // background this whole step exists to get out of the way.
      ctx.imageSmoothingEnabled = false
      try {
        // ORDER: the two SIDE strips first, over the cell's rows only; then the two full-PITCH-wide
        // ROW strips. By the time the top strip copies row `y`, that row already carries the side
        // strips' texels in the left and right gutters — so each corner of the gutter ends up
        // holding the cell's CORNER texel, which is what a clamp-to-edge pad means. Doing the rows
        // first (and the sides over the full pitch height) would work equally well; what must not
        // happen is both passes covering only the cell's own extent, which leaves the four corner
        // squares as stale background.
        //
        // The DESTINATIONS tile the gutter frame exactly — the pitch rect minus the cell's
        // whole-texel box, no overlap and no gap — on a fractional cell too, because `colsW`/`colsH`
        // come from `slotPitch`'s own expression. Only the far-edge SOURCES step inward.
        ctx.drawImage(canvas, x, y, 1, colsH, x - GUTTER_PX, y, GUTTER_PX, colsH)
        ctx.drawImage(canvas, x + lastFullCol, y, 1, colsH, x + colsW, y, GUTTER_PX, colsH)
        ctx.drawImage(
          canvas,
          x - GUTTER_PX,
          y,
          pitchW,
          1,
          x - GUTTER_PX,
          y - GUTTER_PX,
          pitchW,
          GUTTER_PX
        )
        ctx.drawImage(
          canvas,
          x - GUTTER_PX,
          y + lastFullRow,
          pitchW,
          1,
          x - GUTTER_PX,
          y + colsH,
          pitchW,
          GUTTER_PX
        )
      } finally {
        // `finally`, not a trailing assignment: `imageSmoothingEnabled` is PAGE-WIDE state, and a
        // draw that threw part-way (a context lost mid-repack, say) would otherwise leave every
        // later slot's fills unsmoothed for the rest of the session — a permanent, invisible change
        // to a global from a transient failure.
        ctx.imageSmoothingEnabled = prevSmoothing
      }
    }
  }
}
