import { snapPanToDevicePx, type Camera } from './camera'
import { CELL_STRIDE, unpackColor } from './cells'
import type { GlyphGL, GridDrawParams } from './gl'
import { plateRectDevice } from './plate'

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
  // PHASE 1c interim: uv lacks the gutter term — T3 adds uAtlasGutter; glyphs sample 2 texels off
  // until then. The atlas already lays every slot out with GUTTER_PX of ink-free margin inside its
  // pitch cell (atlas.ts), so this origin is one gutter short on both axes; the uv-tie test in
  // atlas.test.ts transcribes the derivation T3 has to land here.
  vec2 slotOrigin = vec2(mod(slot, uAtlasCols), floor(slot / uAtlasCols)) * uAtlasStride;
  vUv = slotOrigin + unit * uAtlasCell;
  vCell = aCell;
}`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uAtlas;
in vec2 vUv;
flat in uvec4 vCell;
out vec4 outColor;
// The exponent the fg/bg coverage mix is performed under (see main()). NOT 2.2: this is a TEXT-AA
// blend gamma, not a display EOTF, and the device bracketed it — 1.0 (a plain sRGB-space mix) read
// thin, 2.2 (the full physical decode) read thick. One named constant so the next nudge, if the
// reference device still reads a hair off in either direction, is a one-token change.
const float BLEND_GAMMA = 1.45;
vec4 rgba8(uint c) {
  return vec4(float(c & 255u), float((c >> 8) & 255u), float((c >> 16) & 255u),
              float((c >> 24) & 255u)) / 255.0;
}
void main() {
  vec4 bg = rgba8(vCell.z);
  vec4 fg = rgba8(vCell.y);
  // COVERAGE COMES OFF THE RED CHANNEL, not alpha. raster.ts paints the atlas page opaque BLACK
  // and the ink WHITE: giving the platform rasterizer a real backdrop is what gets full-weight
  // glyphs out of CoreText on macOS (text drawn onto transparency comes out thin and soft), and it
  // is exactly what xterm's own TextureAtlas does: _drawToCache fills the tile with the
  // background color before every fillText. So the page's LUMINANCE is the coverage; its alpha is
  // 1 everywhere now and carries no information.
  float glyph = texture(uAtlas, vUv).r;
  float cov = glyph * fg.a;
  // THE MIX HAPPENS IN LINEAR LIGHT, NOT IN sRGB.
  //
  // Why: xterm's WebglAddon never mixes anything. It asks CoreText to rasterize the glyph in its
  // REAL fg colour over its REAL bg, so the platform produces the anti-aliased edge pixels itself
  // (with its own gamma-aware blending — which is what makes light-on-dark text come out full),
  // and then blits those pixels 1:1. We rasterize white-on-black COVERAGE once and tint it here,
  // which keeps the atlas key space small (one slot per code point, not per fg/bg pair) but moves
  // the blend into our shader. A mix() on sRGB-encoded values is a LINEAR interpolation of a
  // NON-LINEAR quantity: at coverage 0.5 it emits 0.5, which the display shows at ~0.5^2.2 = 22%
  // of full light instead of 50%. Every mid-coverage edge pixel is under-weighted, and the sum of
  // that over a glyph's outline is exactly the "WebGL text looks thinner/softer" defect the device
  // rounds kept reporting. Decoding, mixing in linear light and re-encoding is what fixes it.
  //
  // BUT THE EXPONENT IS BLEND_GAMMA (1.45), NOT THE PHYSICAL 2.2 — and that is the whole point of
  // this paragraph. The coverage in our atlas is not an abstract geometric coverage: it is
  // CoreText's OWN rasterization of white-on-black, which already carries its font-smoothing
  // compensation for light-on-dark. Compositing that with the full 2.2 decode applies the
  // compensation TWICE, and the device duly reported the result as slightly too thick. Text
  // rasterization stacks land in the same place for the same reason — Skia and FreeType's LCD-filter
  // era blend AA coverage at a gamma around 1.4-1.5, not at the display's 2.2 — because the value
  // being blended came out of a text rasterizer, not out of a photograph.
  //
  // The answer is BRACKETED by device reports, which is why this number is trustworthy rather than
  // picked: 1.0 (a plain sRGB-space mix, rounds 1-6) read THIN, 2.2 (round 7) read THICK, 1.45 sits
  // between them. If the reference device still reads a hair off, move BLEND_GAMMA alone — down
  // toward 1.0 if it looks thick, up toward 2.2 if it looks thin. Nothing else in this shader is a
  // weight knob.
  //
  // Deliberately NOT stacked on top of this: the extra directional coverage boost some GPU text
  // stacks use (cov = pow(cov, 1.0/1.2) when fg is brighter than bg). It pulls in the same
  // direction as BLEND_GAMMA, so two knobs would fight over one device signal — and the bracket
  // above shows a single exponent already spans thin-to-thick. One knob, moved on evidence.
  //
  // If a gap STILL survives this, stop tuning the compositing: the remaining structural difference
  // is that xterm rasterizes in colour at all. Checklist §2.7 already routes that (colour atlas
  // keyed by (code, style, fg, bg) with ink-box cropping — a Phase 2 rework, not a shader patch).
  //
  // Alpha is NOT gamma-encoded and stays a straight lerp, bit-for-bit what the old
  // mix(bg, vec4(fg.rgb, 1.0), cov) produced in that lane — the frame's alpha feeds the
  // SRC_ALPHA/ONE_MINUS_SRC_ALPHA blend and the page composite below it.
  vec3 lin = mix(pow(bg.rgb, vec3(BLEND_GAMMA)), pow(fg.rgb, vec3(BLEND_GAMMA)), cov);
  outColor = vec4(pow(lin, vec3(1.0 / BLEND_GAMMA)), mix(bg.a, 1.0, cov));
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
  /** Last value pushed to `TEXTURE_MIN_FILTER`, so the per-frame call below costs one comparison
   *  instead of a driver round trip. 0 is not a valid enum — it means "never set", which is what
   *  makes the first frame always reach the texture. */
  let atlasMinFilter = 0

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
   *    picks, it now samples the same texel MAG would have.
   *  - **zoom < 1 → LINEAR.** Genuine minification: several texels really do fall into one pixel,
   *    and NEAREST there aliases a zoomed-out canvas into unreadable speckle. Thumbnails stay
   *    readable.
   *
   * MAG stays NEAREST unconditionally — it was never the ambiguous half.
   */
  const applyAtlasMinFilter = (zoom: number): void => {
    const want = zoom >= 1 ? gl.NEAREST : gl.LINEAR
    if (want === atlasMinFilter) return
    atlasMinFilter = want
    gl.bindTexture(gl.TEXTURE_2D, atlasTex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, want)
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
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
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
