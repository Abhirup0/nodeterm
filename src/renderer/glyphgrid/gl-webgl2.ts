import { GUTTER_PX } from './atlas'
import { snapPanToDevicePx, type Camera } from './camera'
import { CELL_STRIDE, unpackColor } from './cells'
import type { GlyphGL, GridDrawParams } from './gl'
import { plateRectDevice } from './plate'

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
 * The residual the clamp accepts is stated in GUTTER_PX's comment: at level 2 a bilinear tap can
 * reach a pure-gutter texel holding a blend of THIS SLOT'S EDGE COLOUR and the NEIGHBOUR'S. For
 * ordinary text both edges are background, so that is the background-vs-background softness it has
 * always been; where two full-bleed slots sit side by side (block art, box-drawing rules) the two
 * edges are ink and can tint each other's outermost sample. Same bounded, accepted class either
 * way — a soft edge at heavy zoom-out, never a ghost glyph.
 */
const MAX_SAFE_LOD = Math.floor(Math.log2(2 * GUTTER_PX))

const VERT = `#version 300 es
// One instance per CELL. Two triangles from gl_VertexID (0..5), no vertex buffer.
uniform vec2 uPan;        // camera pan (screen px)
uniform float uZoom;      // camera zoom
uniform vec2 uView;       // viewport size (screen px)
uniform vec2 uGridOrigin; // grid top-left (world px)
uniform vec2 uCell;       // cell size (world px)
uniform float uCols;
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
  vec2 world = uGridOrigin + (vec2(col, row) + unit) * uCell;
  vec2 screen = world * uZoom + uPan;
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

export function createWebgl2GL(canvas: HTMLCanvasElement): GlyphGL | null {
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false })
  if (!gl) return null
  const program = buildProgram(gl, VERT, FRAG)
  if (!program) return null
  // Locations are stable for the life of a linked program, and getUniformLocation /
  // getAttribLocation are synchronous driver queries — memoize so the per-frame, per-grid call
  // sites below stay a plain map lookup instead of a GL round trip.
  const uniforms = new Map<string, WebGLUniformLocation | null>()
  const u = (name: string): WebGLUniformLocation | null => {
    let loc = uniforms.get(name)
    if (loc === undefined) {
      loc = gl.getUniformLocation(program, name)
      uniforms.set(name, loc)
    }
    return loc
  }
  const aCellLoc = gl.getAttribLocation(program, 'aCell')
  /** One GPU buffer PER GRID, so a change costs only the rows that changed (bufferSubData)
   *  instead of re-uploading every visible grid's whole cell array into one shared buffer. */
  const grids = new Map<string, { buf: WebGLBuffer; cols: number; rows: number }>()
  const atlasTex = gl.createTexture()
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
    const wantMin = zoom >= 1 ? gl.NEAREST : gl.LINEAR_MIPMAP_LINEAR
    const wantMag = zoom > 1 ? gl.LINEAR : gl.NEAREST
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

  gl.useProgram(program)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

  /**
   * The occlusion plate: a scissored `clear` of the grid's PLATE rect — the node body's full
   * world rect, not the character matrix (see `GridDrawParams.plateX`).
   *
   * A clear, not a blended quad, on purpose — it WRITES the colour (blending is bypassed), which
   * is what makes it occlude rather than tint whatever was drawn beneath. Callers therefore pass
   * an OPAQUE bgColor; a translucent one would punch the frame's alpha down to that value.
   *
   * The rect math (camera projection, dpr, the Y flip, clamping) lives in the pure
   * `plate.ts` — it is unit-tested there, since none of it is observable through a GL mock.
   * What stays here is the GL state dance around it.
   */
  // An arrow const, not a `function` declaration: declarations hoist above the `if (!gl) return`
  // narrowing, so `gl` would be `WebGL2RenderingContext | null` inside the body.
  const drawPlate = (g: GridDrawParams): void => {
    // Null = the plate covers no pixel of the drawing buffer; skip it entirely.
    const r = plateRectDevice(
      { x: g.plateX, y: g.plateY, w: g.plateW, h: g.plateH },
      cam,
      dpr,
      deviceW,
      deviceH
    )
    if (!r) return
    const c = unpackColor(g.bgColor)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(r.x, r.y, r.w, r.h)
    gl.clearColor(c.r / 255, c.g / 255, c.b / 255, c.a / 255)
    gl.clear(gl.COLOR_BUFFER_BIT)
    // Disabled again immediately: the scissor is global GL state, and leaving it on would clip
    // the next grid's cells (and the next frame's full-surface clear in beginFrame).
    gl.disable(gl.SCISSOR_TEST)
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

      // --- (1) the plate: an opaque scissored clear of the node BODY's world rect. It is
      // drawn BEFORE this grid's cells and AFTER everything below it in z, so painter's order
      // gives total occlusion of overlapping terminals with no depth buffer.
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
    },
    endFrame() {
      /* single-pass for now; flush point reserved for Phase 1 layering */
    },
    dispose() {
      for (const grid of grids.values()) gl.deleteBuffer(grid.buf)
      grids.clear()
      gl.deleteTexture(atlasTex)
      gl.deleteProgram(program)
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
