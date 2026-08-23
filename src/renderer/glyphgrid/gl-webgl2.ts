import { GUTTER_PX } from './atlas'
import { snapPanToDevicePx, type Camera } from './camera'
import { CELL_STRIDE, unpackColor } from './cells'
import { cursorOverlays, cursorThicknessWorld, MAX_CURSOR_RECTS } from './cursor'
import type { GlyphGL, GridDrawParams } from './gl'
import { plateRadiusDevice, plateRectDevice, plateShapeDevice } from './plate'

/**
 * The deepest mip level the atlas may ever be sampled at (`TEXTURE_MAX_LOD`).
 *
 * DERIVED FROM `GUTTER_PX`, which is why it is computed rather than typed: a level-n texel is the
 * average of an aligned 2^n x 2^n block of level-0 texels, and two slots' CELLS are separated by
 * `2 * GUTTER_PX` texels that belong to one slot or the other and to no third party (this slot's
 * gutter plus its neighbour's — see GUTTER_PX in atlas.ts). A level-n block can therefore only
 * reach content from BOTH slots once 2^n exceeds that separation, so the last safe level is
 * `floor(log2(2 * GUTTER_PX))` = 2 for the gutter of 2 this atlas lays out. Raising the gutter
 * raises this on its own; the two can never disagree.
 *
 * Levels deeper than this are neither generated nor sampled. `generateMipmap` builds levels
 * `base+1 .. q`, where `q` is clamped by `TEXTURE_MAX_LEVEL` (ES 3.0 §3.8.9) — so setting MAX_LEVEL
 * to this constant BEFORE the generate call is what stops the driver building nine levels nobody may
 * read (about 0.35 MB per 2048² page, plus the work). MAX_LOD then forbids the SAMPLER from reaching
 * past it, and the pyramid stays mipmap-COMPLETE because completeness asks only for levels
 * `base .. q` — exactly the ones a clamped generate produces, which is why LINEAR_MIPMAP_LINEAR is
 * still a valid min filter here. (An earlier version of this comment claimed the API offers no way
 * to build fewer levels. It does; that sentence was wrong.)
 *
 * The residual the clamp accepts is stated with its weights in GUTTER_PX's comment. In short: at
 * level 2 a bilinear tap reaches a gutter texel blending THIS SLOT'S EDGE COLOUR with the
 * NEIGHBOUR'S, up to 25% of the sampled value at the worst phase — for ordinary text that is the
 * background-vs-background softness it has always been, and where two full-bleed slots sit side by
 * side (block art, box-drawing rules) it is ink against ink instead. And that texel is not always
 * PURE gutter: at one pitch alignment in four the tap's far level-2 texel straddles the neighbour's
 * first CELL columns, weighting its cell at roughly 6.25% of the sample. That half is PRE-EXISTING
 * — it is about which texels a tap reaches, not what they hold, so edge extension neither caused
 * nor changed it. Both are tints at heavy zoom-out, never a ghost glyph.
 */
const MAX_SAFE_LOD = Math.floor(Math.log2(2 * GUTTER_PX))

/**
 * How close to 1 a zoom may be and still be sampled from LEVEL 0 alone.
 *
 * The mip chain exists for GENUINE zoom-out — a canvas at 0.3 or 0.5, where many texels really do
 * fall into one pixel and plain LINEAR undersamples into shimmer. It was being applied the instant
 * zoom dropped below 1, which is where the 2026-08-09 "text isn't so crisp, might be retina"
 * report came from: the reporting canvas sat at **0.976**. For a 2.4% minification the sampler was
 * blending a half-resolution mip into every glyph — a lot of blur to pay for almost no scaling,
 * and exactly the difference against GPU mode, where xterm draws 1:1 and the COMPOSITOR does the
 * 0.976 in one high-quality pass.
 *
 * A canvas is very rarely at exactly 1. Any pinch, any fitView, any window resize lands on a
 * number like this one, so the near-1 band is not an edge case — it is where most users sit.
 *
 * 0.9 is the floor because that is where dropped texels stop being negligible: at 0.976 roughly
 * one column in forty is skipped, at 0.9 one in ten, and past that a stem starts losing a pixel
 * often enough to read as raggedness rather than as sharpness.
 */
const NEAR_ONE_ZOOM = 0.9

/**
 * Whether cell origins are snapped to whole device pixels — see the VERT comment, which is where
 * the reasoning lives.
 *
 * A module-level switch rather than a uniform the caller owns, because the two candidate answers
 * are being COMPARED on a device we cannot measure from here: `window.__glyphgridSnap(false)`
 * turns it off live, so one session can A/B the same terminal instead of running two builds.
 */
let cellSnap = true

export function setCellSnap(on: boolean): void {
  cellSnap = on
}

export function cellSnapEnabled(): boolean {
  return cellSnap
}

/** The atlas sampler's two filters for a zoom, as names rather than GL enums so the rule can be
 *  tested without a GL context. */
export function atlasFilterChoice(zoom: number): {
  min: 'nearest' | 'linear' | 'trilinear'
  mag: 'nearest' | 'linear'
} {
  // MAG is unchanged: 1 belongs on the crisp side, and above it LINEAR matches the bilinear
  // upscale GPU mode gets from its CSS transform (the 2026-08-04 parity call).
  const mag = zoom > 1 ? 'linear' : 'nearest'
  // At or above 1 nothing is minified and NEAREST is bit-exact.
  if (zoom >= 1) return { min: 'nearest', mag }
  // Just below 1: minified, but barely. LEVEL 0 with LINEAR keeps the glyph's own texels and
  // weights them almost entirely towards the nearest one — sharp, and without the mip blur.
  if (zoom >= NEAR_ONE_ZOOM) return { min: 'linear', mag }
  // Genuine zoom-out: several texels per pixel. Trilinear over the mip chain, which is what stops
  // a zoomed-out canvas shimmering — safe only because the slots carry gutters and the sampler is
  // clamped to MAX_SAFE_LOD, so a minified glyph never averages in its neighbour's ink.
  return { min: 'trilinear', mag }
}

const VERT = `#version 300 es
// One instance per CELL. Two triangles from gl_VertexID (0..5), no vertex buffer.
uniform vec2 uPan;        // camera pan (screen px)
uniform float uZoom;      // camera zoom
uniform vec2 uView;       // viewport size (screen px)
uniform vec2 uGridOrigin; // grid top-left (world px)
uniform vec2 uCell;       // cell size (world px)
uniform float uCols;
uniform float uDpr;       // device pixels per screen px — the grid uCellSnap rounds to
uniform float uCellSnap;  // 1 = snap each cell's origin to a whole device pixel, 0 = don't
uniform vec2 uAtlasCell;   // glyph uv EXTENT (u1-u0, v1-v0) — the exact device cell
uniform vec2 uAtlasStride; // glyph uv PITCH — the whole-texel slot spacing (>= uAtlasCell)
uniform float uAtlasGutter; // GUTTER_PX / atlasSizePx — the ink-free margin inside the pitch cell
uniform float uAtlasCols;
in uvec4 aCell;           // [glyph, fg, bg, flags] — CELL_STRIDE lanes
out vec2 vUv;
flat out uvec4 vCell;
void main() {
  int corner = gl_VertexID;
  vec2 unit = vec2((corner == 1 || corner == 4 || corner == 5) ? 1.0 : 0.0,
                   (corner == 2 || corner == 3 || corner == 5) ? 1.0 : 0.0);
  float col = mod(float(gl_InstanceID), uCols);
  float row = floor(float(gl_InstanceID) / uCols);
  // The cell's ORIGIN and the corner's offset from it, kept apart on purpose — the snap below
  // applies to the origin alone.
  vec2 origin = (uGridOrigin + vec2(col, row) * uCell) * uZoom + uPan;
  vec2 span = uCell * uZoom;
  // SUB-TEXEL PHASE, which is what "shared looks softer than GPU mode" measured down to. A cell is
  // a fractional number of device pixels wide (15.65 at dpr 2 for the default font), so column k
  // starts 0.65k device pixels past a pixel boundary — a different fraction in every column. The
  // atlas is sampled across that fraction, so a filter with any width (LINEAR above zoom 1, LINEAR
  // over level 0 just below it) averages two texels in proportions that vary per column, and every
  // glyph picks up up to half a texel of blur it did not need. Measured against GPU-per-terminal at
  // 2.1x on 2026-08-10: edge ramps 5.1 device px against an ideal 2.1, i.e. ~1 texel of pure phase.
  //
  // GPU mode has the same fractional cell and does NOT pay for it, which is the whole asymmetry:
  // xterm rasterizes every glyph into ONE canvas at 1:1 and the compositor resamples that canvas
  // once, with a SINGLE phase for the whole terminal. Our resample is per cell, so the phase is
  // per cell too.
  //
  // Rounding the origin to a whole device pixel makes the phase 0 in every column, which turns
  // zoom 1 into an exact 1:1 blit and any other zoom into a uniform stretch. The SPAN is left
  // fractional deliberately: rounding it too would quantise the advance and make a monospace row
  // visibly uneven, and it buys nothing — the phase lives entirely in the origin.
  vec2 snapped = mix(origin, floor(origin * uDpr + 0.5) / uDpr, uCellSnap);
  vec2 screen = snapped + unit * span;
  vec2 ndc = vec2(screen.x / uView.x * 2.0 - 1.0, 1.0 - screen.y / uView.y * 2.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  float slot = float(aCell.x);
  // THREE DIFFERENT NUMBERS, and conflating any two of them shifts every glyph. The slot's PITCH
  // cell starts at (slot % cols, slot / cols) * uAtlasStride; the INK starts one GUTTER inside that
  // cell on each axis (the atlas lays every slot out that way so the mip chain has an ink-free
  // margin — see GUTTER_PX in atlas.ts); the sampled EXTENT is the exact device cell, uAtlasCell,
  // which is fractional in general and must never be replaced by the pitch. This is the same
  // derivation GlyphAtlas.slotRect performs on the CPU, and atlas.test.ts's uv-tie test
  // transcribes it independently of both.
  vec2 slotOrigin = vec2(mod(slot, uAtlasCols), floor(slot / uAtlasCols)) * uAtlasStride
                  + vec2(uAtlasGutter);
  vUv = slotOrigin + unit * uAtlasCell;
  vCell = aCell;
}`

const FRAG = `#version 300 es
precision highp float;
// INT PRECISION IS DECLARED, not inherited: GLSL ES 3.00 predeclares only "precision mediump int"
// for fragment shaders, and mediump is guaranteed no more than 16 bits — which is not enough for
// the 32-bit RGBA8 colour lane rgba8() shifts apart below. Desktop drivers all give 32 bits
// anyway, which is why the lanes read correctly before this line existed; saying it makes the
// blank-cell branch's colour independent of that generosity.
precision highp int;
uniform sampler2D uAtlas;
in vec2 vUv;
flat in uvec4 vCell;
out vec4 outColor;
vec4 rgba8(uint c) {
  return vec4(float(c & 255u), float((c >> 8) & 255u), float((c >> 16) & 255u),
              float((c >> 24) & 255u)) / 255.0;
}
void main() {
  // THE ATLAS IS THE PICTURE. Every non-blank slot already holds CoreText's own rasterization of
  // this exact glyph in its exact foreground over its exact background (raster.ts fills the slot
  // with the bg and inks the glyph in the fg; the atlas is keyed by both colours), so the whole
  // fragment stage is one texture read and a blit — precisely what xterm's WebglAddon does.
  //
  // WHAT WAS DELETED HERE, AND WHY IT MUST NOT COME BACK. This shader used to read a white-on-black
  // COVERAGE off the red channel and mix the cell's fg/bg lanes by it under a tuned exponent
  // (BLEND_GAMMA). That mix had no correct setting: the coverage was CoreText's OWN light-on-dark
  // rasterization, which already carries the platform's font-smoothing compensation, so any
  // exponent either under- or double-applied it — seven device rounds bracketed 1.0 as too thin and
  // 2.2 as too thick and never converged. Asking the platform for the colours we actually want
  // removes the mix, and with it the knob: there is nothing left in this shader to tune, which is
  // the point of the change rather than a side effect of it. The cost is the key space (one slot
  // per (code, style, fg, bg) instead of per glyph shape), which the atlas answers with
  // reset-on-full.
  //
  // THE BLANK BRANCH KEYS ON THE GLYPH LANE, NEVER ON SAMPLED ALPHA. A cell whose glyph lane is 0
  // has no slot of its own — space, an unrenderable code point, a not-yet-packed row — so its
  // background lives only in the bg LANE, and this is the branch that paints it. Slot 0 is
  // permanently transparent-black, so sampling it (or alpha-testing the sample) would leave the
  // plate's pixels showing through and a SELECTION OVER WHITESPACE or a BLOCK CURSOR ON AN EMPTY
  // CELL would simply not be drawn — the severe case, since a shell prompt's cursor sits on a blank
  // cell most of the time. An alpha test would also be wrong at zoom-out for a second reason: a
  // minified sample is a mip average, so alpha there is a filtered quantity and not a statement
  // about which slot the cell owns. The lane is exact at every zoom.
  //
  // Alpha comes from the lane rather than being forced to 1: the feed packs opaque backgrounds, so
  // real cells are unaffected, while a grid drawn before its first packed row (a zeroed GPU buffer
  // — see createGrid) keeps alpha 0 and lets its own plate show through instead of flashing opaque
  // black over it for a frame.
  if (vCell.x == 0u) {
    outColor = rgba8(vCell.z);
    return;
  }
  outColor = texture(uAtlas, vUv);
}`

/**
 * The CURSOR OVERLAY program: flat-coloured quads drawn over a grid's cells.
 *
 * It exists because a bar / underline / outline cursor is not expressible as a cell. The cell path
 * can only repaint a whole cell (which is exactly what a BLOCK cursor is, and why a block never
 * reaches this program), so every other shape has to be geometry drawn on top.
 *
 * IT DOES NOT SAMPLE THE ATLAS, and must not: these quads are pure colour, and reading the texture
 * would both cost a fetch per fragment and make the cursor's appearance depend on whatever slot the
 * uv happened to land in. One instance per rect, positions taken from a uniform array rather than a
 * vertex buffer — the whole cursor is at most four small rects (`MAX_CURSOR_RECTS`), so a buffer per
 * frame would be more bookkeeping and more GL calls than the draw itself.
 *
 * The camera uniforms are duplicated rather than shared: uniforms live on a PROGRAM, so there is no
 * such thing as sharing them between two. They are pushed per cursor draw (at most one per grid, and
 * only for a grid that has one) instead of per frame, which keeps a canvas of terminals with block
 * cursors — the default — at exactly zero extra GL calls.
 */
const CURSOR_VERT = `#version 300 es
uniform vec2 uPan;
uniform float uZoom;
uniform vec2 uView;
uniform vec4 uRects[${MAX_CURSOR_RECTS}]; // (x, y, w, h) in WORLD px, one per instance
void main() {
  vec4 r = uRects[gl_InstanceID];
  int corner = gl_VertexID;
  vec2 unit = vec2((corner == 1 || corner == 4 || corner == 5) ? 1.0 : 0.0,
                   (corner == 2 || corner == 3 || corner == 5) ? 1.0 : 0.0);
  vec2 world = r.xy + unit * r.zw;
  vec2 screen = world * uZoom + uPan;
  gl_Position = vec4(screen.x / uView.x * 2.0 - 1.0, 1.0 - screen.y / uView.y * 2.0, 0.0, 1.0);
}`

const CURSOR_FRAG = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = uColor; }`

/**
 * The OCCLUSION PLATE program: one quad per grid, its corners shaped by a rounded-rect SDF.
 *
 * It replaced a scissored `gl.clear`, which was a rectangle by construction — and a node has
 * `border-radius`, while a canvas that is not that node's DOM child cannot be clipped by it. That
 * mismatch is limitation L4: every shared terminal's body corners read square against its own
 * rounded chrome. Rounding needs the plate to be DRAWN rather than cleared, which is this program.
 *
 * DEVICE SPACE, NOT WORLD SPACE — the one thing that makes it different from every other shader in
 * this file. A corner radius is authored against the node's own pixels, and the shape has to stay
 * pixel-exact under a camera the user pans by fractions of a pixel, so the rect and the radius are
 * projected on the CPU (`plateShapeDevice` / `plateRadiusDevice`, both pure and unit-tested) and
 * arrive here already in device px. `gl_FragCoord.xy` is in exactly those coordinates. It is also
 * why NEITHER shader below flips Y: the device rect is already bottom-up, GL's own convention.
 */
const PLATE_VERT = `#version 300 es
uniform vec4 uQuad;   // x, y, w, h in DEVICE px, bottom-left origin — the VISIBLE part of the plate
uniform vec2 uDevice; // drawing-buffer size in device px
void main() {
  int corner = gl_VertexID;
  vec2 unit = vec2((corner == 1 || corner == 4 || corner == 5) ? 1.0 : 0.0,
                   (corner == 2 || corner == 3 || corner == 5) ? 1.0 : 0.0);
  // No Y flip: uQuad is already bottom-up, and so is NDC. Every other vertex shader here starts
  // from top-left world/CSS coordinates and has to flip; this one would DOUBLE-flip if it did.
  gl_Position = vec4((uQuad.xy + unit * uQuad.zw) / uDevice * 2.0 - 1.0, 0.0, 1.0);
}`

const PLATE_FRAG = `#version 300 es
precision highp float;
uniform vec4 uRect;    // the WHOLE plate rect (x, y, w, h) in device px — never the clipped one
uniform float uRadius; // corner radius in device px, already clamped to half the shorter side
uniform vec4 uColor;
out vec4 outColor;
void main() {
  vec2 halfExtent = uRect.zw * 0.5;
  vec2 p = gl_FragCoord.xy - (uRect.xy + halfExtent);
  // ONLY THE BOTTOM CORNERS ARE ROUNDED, and this line is the whole of that rule. The plate rect
  // is a node BODY, and the body is the node's LAST child: its bottom edge IS the node's bottom
  // (rounded, with nothing behind it but canvas), while its top edge is an interior seam against
  // opaque chrome — the header, the labels row, the find bar. Rounding the top corners would not
  // shape a visible corner at all, it would carve two wedges out of the body that nothing else
  // paints, i.e. trade L4 for a new artifact. Device Y grows UP, so the node's visual bottom is
  // the p.y < 0 half.
  //
  // The two halves cannot seam: away from a corner the rounded and square fields are IDENTICAL
  // (the inner box is inset by r on both axes and the distance has r added back), so they agree
  // exactly along p.y = 0, which is the mid-height of the body and as far from a corner as a
  // fragment gets.
  float r = p.y < 0.0 ? uRadius : 0.0;
  vec2 q = abs(p) - (halfExtent - vec2(r));
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  // ONE DEVICE PIXEL OF COVERAGE, CENTRED ON THE EDGE — so the corner is antialiased instead of
  // stepped (a hard corner on the terminal's own background reads as a rendering fault, not as a
  // shape), while a STRAIGHT edge stays fully opaque. That centring is load-bearing and is where
  // this deviates from the obvious "1.0 - smoothstep(-1.0, 0.0, d)": the plate's device rect is
  // rounded to whole pixels, so an edge lands exactly on a pixel BOUNDARY, whose neighbouring
  // fragment centres sit at d = -0.5 (inside) and d = +0.5 (outside). A window centred on 0 puts
  // those at alpha 1 and 0 — the same pixels the old clear wrote, exactly. A window running
  // from -1 to 0 would put the last inside row at alpha 0.5 and let a half-covered line of the
  // TRANSPARENT node body (i.e. raw canvas) show around all four straight edges: the band this
  // plate exists to remove.
  outColor = vec4(uColor.rgb, uColor.a * clamp(0.5 - d, 0.0, 1.0));
}`

export function createWebgl2GL(canvas: HTMLCanvasElement): GlyphGL | null {
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false })
  if (!gl) return null
  /**
   * EVERY GPU OBJECT BELOW IS `let`, NOT `const`, BECAUSE A LOST CONTEXT TAKES ALL OF THEM.
   *
   * `webglcontextrestored` hands back the SAME `WebGL2RenderingContext` object with every program,
   * texture, buffer and uniform location it held deleted — so the whole set is rebuilt by
   * `restore()` (see `buildGpuObjects`) and re-assigned here. The closures below read these
   * bindings on every call rather than capturing a value, which is what makes a rebuild invisible
   * to them.
   */
  let program: WebGLProgram | null = null
  let cursorProgram: WebGLProgram | null = null
  let plateProgram: WebGLProgram | null = null
  let atlasTex: WebGLTexture | null = null
  let aCellLoc = 0
  // Locations are stable for the life of a linked program, and getUniformLocation /
  // getAttribLocation are synchronous driver queries — memoize so the per-frame, per-grid call
  // sites below stay a plain map lookup instead of a GL round trip. CLEARED on a rebuild: a
  // location belongs to the program it was queried from, and a stale one addresses nothing on the
  // program that replaced it.
  const uniforms = new Map<string, WebGLUniformLocation | null>()
  const u = (name: string): WebGLUniformLocation | null => {
    if (!program) return null
    let loc = uniforms.get(name)
    if (loc === undefined) {
      loc = gl.getUniformLocation(program, name)
      uniforms.set(name, loc)
    }
    return loc
  }
  const cursorUniforms = new Map<string, WebGLUniformLocation | null>()
  const cu = (name: string): WebGLUniformLocation | null => {
    if (!cursorProgram) return null
    let loc = cursorUniforms.get(name)
    if (loc === undefined) {
      loc = gl.getUniformLocation(cursorProgram, name)
      cursorUniforms.set(name, loc)
    }
    return loc
  }
  /** Scratch for the overlay's rect uniforms — one allocation for the life of the context rather
   *  than one per cursor per frame. Pure CPU memory, so a context loss does not touch it. */
  const cursorRectData = new Float32Array(MAX_CURSOR_RECTS * 4)
  const plateUniforms = new Map<string, WebGLUniformLocation | null>()
  const pu = (name: string): WebGLUniformLocation | null => {
    if (!plateProgram) return null
    let loc = plateUniforms.get(name)
    if (loc === undefined) {
      loc = gl.getUniformLocation(plateProgram, name)
      plateUniforms.set(name, loc)
    }
    return loc
  }
  /** One GPU buffer PER GRID, so a change costs only the rows that changed (bufferSubData)
   *  instead of re-uploading every visible grid's whole cell array into one shared buffer. */
  const grids = new Map<string, { buf: WebGLBuffer; cols: number; rows: number }>()
  let atlasCols = 1
  let atlasCellUv: [number, number] = [0, 0]
  let atlasStrideUv: [number, number] = [0, 0]
  /** GUTTER_PX expressed in uv — the ink-free margin the VERT adds to every slot origin. Derived
   *  from the page size the atlas uploads with, so `uploadAtlas` keeps its signature: the gutter is
   *  a layout constant both sides already share, not a new piece of per-upload data. */
  let atlasGutterUv = 0
  let view: [number, number] = [1, 1]
  /** Stored at resize because the plate's scissor rect is in DEVICE pixels and needs the
   *  drawing buffer's height to flip Y — neither is derivable from the CSS-px viewport alone. */
  let dpr = 1
  // Seeded from the canvas so a plate drawn before the first resize() still clamps against the
  // real drawing buffer instead of a 1x1 placeholder.
  let deviceW = canvas.width
  let deviceH = canvas.height
  /** The camera of the frame in flight — the plate rect is computed on the CPU (world → screen),
   *  so drawGrid needs it. */
  let cam: Camera = { x: 0, y: 0, zoom: 1 }
  /** Last values pushed to `TEXTURE_MIN_FILTER` / `TEXTURE_MAG_FILTER`, so the per-frame call
   *  below costs one comparison instead of a driver round trip. 0 is not a valid enum — it means
   *  "never set", which is what makes the first frame always reach the texture. */
  let atlasMinFilter = 0
  let atlasMagFilter = 0

  /**
   * Pick the atlas's MINIFICATION filter from the camera zoom — the fix for "text is nearly, but
   * not quite, crisp at 100%".
   *
   * The atlas is rasterized at xterm's exact DEVICE cell, so at zoom 1 a glyph's quad is exactly
   * as many device pixels as the slot has texels: a 1:1 mapping, which puts the sampler's
   * level-of-detail on the **λ = 0 tie** between magnification and minification. Which side a
   * driver resolves that tie to is not specified, and a driver that lands on MINIFICATION used
   * `MIN_FILTER = LINEAR` — a four-texel average of an exact 1:1 sample, i.e. the residual
   * softness reported from the device after the atlas was already made 1:1.
   *
   * So make the answer deterministic instead of hoping both sides agree:
   *  - **zoom >= 1 → NEAREST.** The pan is snapped to whole device pixels (`snapPanToDevicePx`)
   *    and the texels are 1:1, so NEAREST is bit-exact — whichever side of the tie the driver
   *    picks, it now samples the same texel MAG would have. The comparison stays `>=` for exactly
   *    that reason: zoom 1 IS the tie, and it belongs on the crisp side.
   *  - **zoom < 1 → LINEAR_MIPMAP_LINEAR.** Genuine minification: several texels really do fall
   *    into one pixel. Plain LINEAR (what this used to be) averages four LEVEL-0 texels however
   *    many actually land in the pixel, which is why a zoomed-out canvas shimmered and aliased —
   *    it is an undersample, not a filter. Trilinear over the mip chain `uploadAtlas` generates is
   *    the same thing every GPU text stack does, and it is what makes zoom-out read as GPU-mode
   *    class rather than as speckle. It is safe here only because the slots carry gutters and the
   *    sampler is clamped to MAX_SAFE_LOD — without both, a minified glyph would average in its
   *    neighbour's ink.
   *
   * MAG is zoom-driven too, for GPU-MODE PARITY when zoomed IN (device round, 2026-08-04):
   *  - **zoom == 1 → NEAREST.** The 1:1 case above — bit-exact, and 1 belongs on the crisp side.
   *  - **zoom > 1 → LINEAR.** The per-terminal WebglAddon renders 1:1 and lets the canvas's CSS
   *    transform bilinearly upscale the finished image, so GPU mode is SOFT when zoomed in.
   *    NEAREST here was measurably sharper but duplicated texels unevenly at fractional zoom
   *    (stems wobbling 5-6-7 device px), which reads as raggedness next to GPU mode's smooth
   *    scale. LINEAR magnification of the same level-0 texels is the same class of bilinear
   *    upscale the CSS transform applies — the user chose parity over the extra sharpness.
   *    An edge tap reaches at most 1 texel outside the cell extent, which is the slot's own
   *    EDGE-EXTENDED gutter (2 texels) — never a neighbour's ink. Edge-extended rather than
   *    bg-filled matters here too: on a full-bleed glyph that tap now continues the ink instead of
   *    darkening towards the background.
   */
  const applyAtlasMinFilter = (zoom: number): void => {
    const choice = atlasFilterChoice(zoom)
    const wantMin =
      choice.min === 'nearest'
        ? gl.NEAREST
        : choice.min === 'linear'
          ? gl.LINEAR
          : gl.LINEAR_MIPMAP_LINEAR
    const wantMag = choice.mag === 'linear' ? gl.LINEAR : gl.NEAREST
    if (wantMin === atlasMinFilter && wantMag === atlasMagFilter) return
    gl.bindTexture(gl.TEXTURE_2D, atlasTex)
    if (wantMin !== atlasMinFilter) {
      atlasMinFilter = wantMin
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, wantMin)
    }
    if (wantMag !== atlasMagFilter) {
      atlasMagFilter = wantMag
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, wantMag)
    }
  }

  /**
   * Straight (non-premultiplied) source colours over a PREMULTIPLIED drawing buffer — which is
   * what `getContext('webgl2', {alpha: true})` gives, since `premultipliedAlpha` defaults to true
   * and nothing above overrides it.
   *
   * The alpha channel needs its OWN source factor, and this used to be a plain `blendFunc`. With
   * one factor for all four channels the destination alpha comes out as `srcA²` over an empty
   * buffer, so a fragment at half coverage leaves the surface a QUARTER opaque, and the browser —
   * compositing premultiplied — then lets 75% of the page through a pixel that is 50% covered. A
   * bright halo along a soft edge, on the light theme especially.
   *
   * WHAT IT CHANGES, in three cases — and the third is a FIX, not a side effect:
   *  - **Fully opaque** sources (a packed cell, the cursor overlay): unaffected. `srcA * srcA` and
   *    `1 * srcA` are both 1.
   *  - **Fully transparent** sources (a grid's zeroed buffer before its first packed row):
   *    unaffected. Both are 0, and the destination keeps its own alpha either way.
   *  - **PARTIALLY transparent** sources, which the plate's antialiased corner is NOT the first of.
   *    `raster.ts` documents a pre-existing one and this blend improves it: the atlas is uploaded
   *    NON-premultiplied, so wherever a mip level averages a slot's opaque background against the
   *    page's transparent ground — the allocation frontier, the page's right/bottom remainder
   *    strip, and the whole page right after a `clearPage` repack — a level-2 texel comes out half
   *    brightness at half alpha, and `LINEAR_MIPMAP_LINEAR` is the min filter at any zoom below 1,
   *    i.e. in ordinary use. Under the old single-factor blend such a rim texel left `dstA = 0.75`,
   *    so the PLATE underneath it (and the page under that) showed through a cell that had already
   *    been painted — the rim's page-bleed half. With `ONE` on the source alpha the surface stays
   *    fully opaque there, and only the colour half of that residual is left (see `raster.ts` — the
   *    non-premultiplied UPLOAD is what still double-attenuates the rim's brightness).
   */
  const applyBlend = (): void => {
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  }

  /**
   * Build (or REBUILD) every GPU object and every piece of context-wide GL state this layer owns.
   *
   * Called once at construction and again by `restore()` after a context loss. Returns false when
   * the CELL program will not build — the one object with no degrade, since without it a terminal
   * has no text at all. The two other programs may each come back null and are handled where they
   * are used (see `cursorProgram` / `plateProgram` below).
   *
   * Everything reset here is state a context loss takes with it. The filter cache is the trap: it
   * records what was last pushed to the TEXTURE, and the texture is new — leaving it would make
   * `applyAtlasMinFilter` skip its first call and hand the sampler a mip-filtered texture with no
   * mip chain, which samples black. The viewport is the other one: `engine.setViewport` is
   * change-gated, so nothing re-pushes the size after a restore and the default viewport of a fresh
   * drawing buffer would be whatever the canvas element happens to be.
   */
  const buildGpuObjects = (): boolean => {
    program = buildProgram(gl, VERT, FRAG)
    uniforms.clear()
    cursorUniforms.clear()
    plateUniforms.clear()
    if (!program) return false
    aCellLoc = gl.getAttribLocation(program, 'aCell')
    /** The overlay program, and null when it failed to build. Null is a DEGRADE, not a failure: the
     *  cells still draw, and the terminal loses only a non-block cursor — never its text. */
    cursorProgram = buildProgram(gl, CURSOR_VERT, CURSOR_FRAG)
    /** The plate program, and null when it failed to build. Null is NOT the cursor's kind of
     *  degrade: without a plate a terminal has no opaque ground at all, and the node body is
     *  transparent in shared mode — the canvas dot grid would show straight through every terminal,
     *  and overlapping terminals would stop occluding each other. So the null path falls back to the
     *  scissored `clear` this program replaced (square corners, i.e. L4) rather than to nothing. */
    plateProgram = buildProgram(gl, PLATE_VERT, PLATE_FRAG)
    atlasTex = gl.createTexture()
    // "Never set" — see `atlasMinFilter`. The fresh texture carries GL's defaults, whatever the
    // old one was left holding.
    atlasMinFilter = 0
    atlasMagFilter = 0
    gl.useProgram(program)
    gl.viewport(0, 0, deviceW, deviceH)
    gl.enable(gl.BLEND)
    applyBlend()
    return true
  }

  // The first build. A failure here is the same "no shared renderer on this machine" answer as a
  // missing WebGL2 context, and the caller stays on the DOM renderer.
  if (!buildGpuObjects()) return null

  /**
   * The occlusion plate: an opaque quad over the grid's PLATE rect — the node body's full world
   * rect, not the character matrix (see `GridDrawParams.plateX`) — with its bottom corners rounded
   * to the node's own radius.
   *
   * **PAINTER ORDER IS UNCHANGED, and saying so is the point of this paragraph.** The plate is
   * still drawn BEFORE this grid's cells and AFTER every lower grid, exactly where the scissored
   * `clear` sat; the whole Phase-1a occlusion story is that call order, and moving from a clear to
   * a BLENDED draw is precisely the change that could break it without looking like it had. It
   * does not, because the plate is opaque: `bgColor` carries alpha 0xff (`packThemeBg` forces it,
   * for this reason), and the blend func above at srcA = 1 resolves to `dst = src` for colour AND
   * alpha — the same bits the clear wrote. Only the corner fragments, where the SDF's
   * coverage falls below 1, blend at all, and blending is exactly what a rounded corner wants
   * there. **A translucent bgColor would now TINT what is underneath instead of punching a hole in
   * the frame's alpha** — a better failure than the clear's, but still not a supported input.
   *
   * TWO RECTS, and conflating them is the trap. `plateRectDevice` answers which pixels are worth
   * drawing (clamped to the buffer, null when none are); `plateShapeDevice` answers where the node
   * ACTUALLY is (unclamped). The quad is drawn over the first — minimal overdraw, and no reliance
   * on the rasterizer to clip a rect that may sit far outside the viewport — while the SDF, and
   * the radius clamp, measure against the second. Feeding the clamped rect to the shader would
   * draw the node's rounded corner at the VIEWPORT edge on any node merely half scrolled off.
   *
   * All of that math is pure and lives in `plate.ts`, unit-tested, since none of it is observable
   * through a GL mock. What stays here is the GL state dance around it.
   *
   * COST, stated because it did go up: a scissored clear is a fast path most GPUs answer without
   * running a fragment shader, and this is a shaded quad over the same area — one invocation of
   * four arithmetic ops and a `length()` per body pixel per visible grid. It is strictly less work
   * than the CELL pass over that same area (which fetches a texture per fragment) and it is
   * culled by the same `drawOrder`, so it does not change the shape of the frame's cost. If it
   * ever shows up in a profile the escalation is a stencil or a scissored clear plus four small
   * corner quads — not speculative work.
   *
   * STATE TOUCHED, AND RESTORED. (1) the current PROGRAM — switched to the plate program and put
   * back to the cell program on the way out, the same discipline `drawCursor` follows, since
   * `beginFrame` binds the cell program once for the whole frame. (2) the `aCell` attribute ARRAY
   * — disabled here and re-enabled by `drawGrid` for every grid immediately after; a driver that
   * fetches enabled-but-unused arrays would read the previous grid's buffer at divisor 1. Nothing
   * else: no buffer is bound (positions come from uniforms and `gl_VertexID`), no texture, no
   * blend change, no viewport change — and, unlike the clear it replaced, no SCISSOR_TEST, which
   * is now never enabled at all.
   */
  // An arrow const, not a `function` declaration: declarations hoist above the `if (!gl) return`
  // narrowing, so `gl` would be `WebGL2RenderingContext | null` inside the body.
  const drawPlate = (g: GridDrawParams): void => {
    const world = { x: g.plateX, y: g.plateY, w: g.plateW, h: g.plateH }
    // Null = the plate covers no pixel of the drawing buffer; skip it entirely. Kept from the
    // clear-based version, where it also guarded against a GL_INVALID_VALUE scissor; here it is
    // purely the early-out that keeps an off-screen node free.
    const clip = plateRectDevice(world, cam, dpr, deviceW, deviceH)
    if (!clip) return
    const c = unpackColor(g.bgColor)
    if (!plateProgram) {
      // The degrade: no plate program, so fall back to the scissored clear. Square corners (L4)
      // beat no occlusion at all — see `plateProgram`.
      gl.enable(gl.SCISSOR_TEST)
      gl.scissor(clip.x, clip.y, clip.w, clip.h)
      gl.clearColor(c.r / 255, c.g / 255, c.b / 255, c.a / 255)
      gl.clear(gl.COLOR_BUFFER_BIT)
      // Disabled again immediately: the scissor is global GL state, and leaving it on would clip
      // the next grid's cells (and the next frame's full-surface clear in beginFrame).
      gl.disable(gl.SCISSOR_TEST)
      return
    }
    const shape = plateShapeDevice(world, cam, dpr, deviceH)
    // `cam.zoom * dpr` is the same world → device scale every extent above went through, so the
    // radius can never drift out of proportion with the rect it rounds.
    const radius = plateRadiusDevice(g.plateRadius, cam.zoom * dpr, shape)
    gl.disableVertexAttribArray(aCellLoc)
    gl.useProgram(plateProgram)
    gl.uniform4f(pu('uQuad'), clip.x, clip.y, clip.w, clip.h)
    gl.uniform2f(pu('uDevice'), deviceW, deviceH)
    gl.uniform4f(pu('uRect'), shape.x, shape.y, shape.w, shape.h)
    gl.uniform1f(pu('uRadius'), radius)
    gl.uniform4f(pu('uColor'), c.r / 255, c.g / 255, c.b / 255, c.a / 255)
    // Two triangles from gl_VertexID, no vertex buffer — the same trick the cell and cursor
    // programs use. NOT instanced: there is exactly one plate per grid.
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    // RESTORED, always — see the state note above.
    gl.useProgram(program)
  }

  /**
   * The cursor overlay for one grid — the bar / underline / outline a cell cannot express.
   *
   * Damage-driven like everything else: this runs inside a frame the engine decided to draw, and the
   * engine only decides that when something changed (`setCursor` is change-gated). Nothing here
   * schedules, times or holds the rAF loop awake — a blinking cursor is Task 3's `pulse()`, not a
   * timer hidden in the GL layer.
   *
   * The GEOMETRY is computed here rather than carried in `GridDrawParams` because it depends on the
   * CAMERA: the mark is a hairline, defined in device pixels, so its world-unit thickness changes
   * with every zoom tick (`cursorThicknessWorld`). Recomputing it per draw is four multiplications;
   * pushing a new spec through the engine on every zoom step would be damage on every frame of a
   * pinch gesture.
   */
  const drawCursor = (g: GridDrawParams): void => {
    const c = g.cursor
    if (!c || !cursorProgram) return
    const rects = cursorOverlays(
      c.shape,
      c.widthCells,
      cursorThicknessWorld(cam.zoom, dpr),
      g.cellW,
      g.cellH
    )
    // Empty for a block (the cell path drew it), for `none`, and for a degenerate cell. No program
    // switch, no draw call — which is what keeps the default block cursor free.
    if (rects.length === 0) return
    const baseX = g.originX + c.col * g.cellW
    const baseY = g.originY + c.row * g.cellH
    const n = Math.min(rects.length, MAX_CURSOR_RECTS)
    for (let i = 0; i < n; i++) {
      const r = rects[i]
      cursorRectData[i * 4] = baseX + r.x
      cursorRectData[i * 4 + 1] = baseY + r.y
      cursorRectData[i * 4 + 2] = r.w
      cursorRectData[i * 4 + 3] = r.h
    }
    // The cell attribute array is disabled for the duration: it is enabled with divisor 1 and bound
    // to the GRID's buffer, and this instanced draw asks for as many instances as there are rects.
    // A driver that fetches enabled-but-unused arrays would read past a small grid's buffer.
    // `drawGrid` re-enables it per grid, so nothing downstream depends on it staying on.
    gl.disableVertexAttribArray(aCellLoc)
    gl.useProgram(cursorProgram)
    gl.uniform2f(cu('uPan'), cam.x, cam.y)
    gl.uniform1f(cu('uZoom'), cam.zoom)
    gl.uniform2f(cu('uView'), view[0], view[1])
    // WebGL2's srcOffset/srcLength overload, NOT a `subarray`: the view would be an allocation per
    // cursor per frame, which is precisely what the scratch buffer above exists to avoid.
    gl.uniform4fv(cu('uRects'), cursorRectData, 0, n * 4)
    const col = unpackColor(c.color)
    gl.uniform4f(cu('uColor'), col.r / 255, col.g / 255, col.b / 255, col.a / 255)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n)
    // RESTORED, always: `beginFrame` binds the cell program once for the whole frame, so leaving
    // this one current would make the NEXT grid draw its cells through a shader that paints flat
    // rectangles — a canvas of blank coloured boxes after the first terminal with a bar cursor.
    gl.useProgram(program)
  }

  return {
    resize(w, h, ratio) {
      canvas.width = Math.round(w * ratio)
      canvas.height = Math.round(h * ratio)
      view = [w, h]
      dpr = ratio
      deviceW = canvas.width
      deviceH = canvas.height
      gl.viewport(0, 0, canvas.width, canvas.height)
    },
    uploadAtlas(source, sizePx, cellW, cellH, strideX, strideY) {
      gl.bindTexture(gl.TEXTURE_2D, atlasTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      // THE MIP CHAIN, rebuilt on every upload. A minifying sampler with no chain is either an
      // undersample (LINEAR over four level-0 texels — the old zoom-out shimmer) or an INCOMPLETE
      // texture that samples black (any *_MIPMAP_* filter), so the chain has to exist before the
      // filter below can ask for it, and it has to be regenerated here because texImage2D replaces
      // level 0 only and leaves the rest stale.
      //
      // COST: one full pyramid over the whole page (2048² today) per atlas-dirty upload. That rate
      // is bounded by GLYPH ALLOCATION, not by frames — the atlas dirties when a new (code, style,
      // fg, bg) key is rasterized, which on a settled canvas is never. Fine as it stands. If it
      // ever shows up in a profile the escalation is a dirty-RECT texSubImage2D plus a manual mip
      // of the touched tiles; that is Phase 2 work and must not be built speculatively.
      //
      // The page size is mip-friendly: 2048 is a power of two, so every level is an exact halving
      // down to 1×1. WebGL2 also allows mipmaps on NPOT textures, so a future page size is not a
      // correctness hazard here — only a rounding one at the deepest levels, which MAX_SAFE_LOD
      // never lets the sampler reach.
      //
      // BEFORE the generate, never after: `generateMipmap` builds levels up to `q`, which
      // TEXTURE_MAX_LEVEL clamps, so setting it here is what makes the pyramid stop at the deepest
      // level the sampler is allowed to read (MAX_LOD below). Set afterwards it would only hide
      // levels that had already been built. The texture stays mipmap-COMPLETE — completeness wants
      // levels base..q and a clamped generate produces exactly those — which is what keeps
      // LINEAR_MIPMAP_LINEAR a legal min filter.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, MAX_SAFE_LOD)
      gl.generateMipmap(gl.TEXTURE_2D)
      // The clamp the gutters pay for: levels deeper than MAX_SAFE_LOD may mix a neighbouring
      // slot's ink into this one, so the sampler is forbidden to reach them however far the canvas
      // is zoomed out. `texParameterf` — MAX_LOD is a float parameter, and the `i` form would
      // silently be the wrong entry point for it.
      gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MAX_LOD, MAX_SAFE_LOD)
      // MIN belongs to the camera now (see applyAtlasMinFilter), but it is asserted HERE too, and
      // not only in beginFrame: GL's default min filter is NEAREST_MIPMAP_LINEAR, which makes a
      // texture with no mip chain INCOMPLETE (it samples black). Filter params live on the texture
      // object and survive texImage2D, so this is a one-time cost the change gate absorbs.
      applyAtlasMinFilter(cam.zoom)
      // Columns follow the PITCH (that is how the atlas laid the page out), while the sampled
      // extent stays the exact cell — mixing the two shifts every glyph by a fraction of a cell.
      atlasCols = Math.floor(sizePx / strideX)
      atlasCellUv = [cellW / sizePx, cellH / sizePx]
      atlasStrideUv = [strideX / sizePx, strideY / sizePx]
      // The gutter is a LAYOUT constant shared with the atlas, so it is derived here from the page
      // size rather than added to this signature — one fewer number for a caller to get wrong.
      atlasGutterUv = GUTTER_PX / sizePx
    },
    createGrid(id, cols, rows) {
      // Re-creating under a live id is the RESIZE path: drop the old buffer first, or every
      // reshape leaks one buffer for the life of the context.
      const prev = grids.get(id)
      if (prev) gl.deleteBuffer(prev.buf)
      const buf = gl.createBuffer()
      if (!buf) {
        grids.delete(id)
        return
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      // Size-only overload: allocates the storage zero-filled, so a grid drawn before its first
      // uploadRows samples slot 0 (the atlas's permanently blank glyph) rather than garbage.
      gl.bufferData(gl.ARRAY_BUFFER, cols * rows * CELL_STRIDE * 4, gl.DYNAMIC_DRAW)
      grids.set(id, { buf, cols, rows })
    },
    disposeGrid(id) {
      const g = grids.get(id)
      if (!g) return
      gl.deleteBuffer(g.buf)
      grids.delete(id)
    },
    uploadRows(id, firstRow, rowCount, cols, cells) {
      const expected = rowCount * cols * CELL_STRIDE
      // Throw rather than let bufferSubData run short/long: the offset below is computed from
      // firstRow, so a mismatched length silently scribbles across the neighbouring rows.
      if (cells.length !== expected)
        throw new Error(`glyphgrid: rows length ${cells.length} != ${expected}`)
      const g = grids.get(id)
      // No buffer = a grid disposed between the engine's upload and this call. Nothing to write.
      if (!g) return
      gl.bindBuffer(gl.ARRAY_BUFFER, g.buf)
      gl.bufferSubData(gl.ARRAY_BUFFER, firstRow * cols * CELL_STRIDE * 4, cells)
    },
    beginFrame(camera: Camera) {
      // COPIED, not aliased (the plate math reads this during the drawGrid calls that follow, and
      // a caller mutating its own camera object mid-frame would move grids apart) — and SNAPPED:
      // a sub-device-pixel pan makes the NEAREST-sampled atlas resample every glyph differently
      // each frame, which is the shimmer that made panned text look like it was rippling behind
      // its node. See `snapPanToDevicePx`; the plate reads the same snapped camera, so plate and
      // cells can never drift a pixel apart.
      cam = snapPanToDevicePx(camera, dpr)
      // Resolve the mag/min tie for THIS frame's zoom before anything samples the atlas. Change-
      // gated, so a still camera costs one comparison per frame and zero GL calls.
      applyAtlasMinFilter(cam.zoom)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(program)
      gl.uniform2f(u('uPan'), cam.x, cam.y)
      gl.uniform1f(u('uZoom'), cam.zoom)
      gl.uniform2f(u('uView'), view[0], view[1])
      gl.uniform1f(u('uDpr'), dpr)
      gl.uniform1f(u('uCellSnap'), cellSnap ? 1 : 0)
      gl.uniform1f(u('uAtlasCols'), atlasCols)
      gl.uniform2f(u('uAtlasCell'), atlasCellUv[0], atlasCellUv[1])
      gl.uniform2f(u('uAtlasStride'), atlasStrideUv[0], atlasStrideUv[1])
      gl.uniform1f(u('uAtlasGutter'), atlasGutterUv)
      gl.uniform1i(u('uAtlas'), 0)
    },
    drawGrid(g: GridDrawParams) {
      const grid = grids.get(g.id)
      // Never drawn without its own buffer: an unregistered id would otherwise draw whatever
      // buffer happened to be bound from the previous grid.
      if (!grid) return

      // --- (1) the plate: an opaque rounded quad over the node BODY's world rect. It is
      // drawn BEFORE this grid's cells and AFTER everything below it in z, so painter's order
      // gives total occlusion of overlapping terminals with no depth buffer. This call site is
      // where that order lives, and it has not moved — see `drawPlate` on why a blended draw
      // still occludes.
      drawPlate(g)

      // --- (2) the cells, instanced from the grid's own buffer.
      gl.uniform2f(u('uGridOrigin'), g.originX, g.originY)
      gl.uniform2f(u('uCell'), g.cellW, g.cellH)
      gl.uniform1f(u('uCols'), g.cols)
      gl.bindBuffer(gl.ARRAY_BUFFER, grid.buf)
      // The attribute pointer captures the buffer bound AT THE MOMENT of the call — it is
      // per-bind state, not program state. With one buffer per grid every drawGrid rebinds, so
      // the pointer MUST be re-set here; hoisting it out of the loop would make every grid draw
      // the cells of whichever grid was bound when it last ran.
      gl.enableVertexAttribArray(aCellLoc)
      // 4 uint lanes, CELL_STRIDE * 4 bytes apart — this MUST mirror cells.ts one-to-one.
      gl.vertexAttribIPointer(aCellLoc, 4, gl.UNSIGNED_INT, CELL_STRIDE * 4, 0)
      gl.vertexAttribDivisor(aCellLoc, 1)
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, g.cols * g.rows)

      // --- (3) the cursor overlay, ON TOP of this grid's own cells and UNDER whatever grid is
      // drawn after it — the same painter's order the plate and the cells already obey.
      drawCursor(g)
    },
    endFrame() {
      /* single-pass for now; flush point reserved for Phase 1 layering */
    },
    restore() {
      // NOTHING IS DELETED FIRST, and that is not an oversight: the context that owned these
      // objects took them with it, so `deleteProgram`/`deleteBuffer` here would be calls against
      // names that no longer exist. The grid TABLE is emptied instead, because it is CPU-side
      // bookkeeping that outlived the buffers it points at — leaving it would make the engine's
      // very next `createGrid` (which frees a live buffer before reallocating, the resize path)
      // try to delete one of those dead names.
      grids.clear()
      if (!buildGpuObjects())
        // Throwing rather than returning a flag: the interface says so, and the caller's only
        // correct answer is the permanent fallback. A context whose cell program will not compile
        // draws nothing, which on a canvas of transparent node bodies is indistinguishable from a
        // freeze.
        throw new Error('glyphgrid: the GL programs would not rebuild after a context restore')
    },
    dispose() {
      for (const grid of grids.values()) gl.deleteBuffer(grid.buf)
      grids.clear()
      gl.deleteTexture(atlasTex)
      if (program) gl.deleteProgram(program)
      if (cursorProgram) gl.deleteProgram(cursorProgram)
      if (plateProgram) gl.deleteProgram(plateProgram)
    }
  }
}

function buildProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const compile = (type: number, src: string): WebGLShader | null => {
    const sh = gl.createShader(type)
    if (!sh) return null
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[glyphgrid] shader compile failed:', gl.getShaderInfoLog(sh))
      gl.deleteShader(sh)
      return null
    }
    return sh
  }
  const v = compile(gl.VERTEX_SHADER, vs)
  const f = compile(gl.FRAGMENT_SHADER, fs)
  if (!v || !f) {
    // One half may have compiled before the other failed — it would otherwise leak, since
    // nothing ever attaches it to a program.
    if (v) gl.deleteShader(v)
    if (f) gl.deleteShader(f)
    return null
  }
  const p = gl.createProgram()
  if (!p) {
    gl.deleteShader(v)
    gl.deleteShader(f)
    return null
  }
  gl.attachShader(p, v)
  gl.attachShader(p, f)
  gl.linkProgram(p)
  // Attached shaders are refcounted by the program: flag them for deletion now so they go away
  // with it (dispose() only deletes the program).
  gl.deleteShader(v)
  gl.deleteShader(f)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn('[glyphgrid] program link failed:', gl.getProgramInfoLog(p))
    gl.deleteProgram(p)
    return null
  }
  return p
}
