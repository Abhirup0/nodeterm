import type { Camera } from './camera'
import { CELL_STRIDE, unpackColor } from './cells'
import type { GlyphGL, GridDrawParams } from './gl'

const VERT = `#version 300 es
// One instance per CELL. Two triangles from gl_VertexID (0..5), no vertex buffer.
uniform vec2 uPan;        // camera pan (screen px)
uniform float uZoom;      // camera zoom
uniform vec2 uView;       // viewport size (screen px)
uniform vec2 uGridOrigin; // grid top-left (world px)
uniform vec2 uCell;       // cell size (world px)
uniform float uCols;
uniform vec2 uAtlasCell;  // glyph uv size (u1-u0, v1-v0)
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
  vec2 slotOrigin = vec2(mod(slot, uAtlasCols), floor(slot / uAtlasCols)) * uAtlasCell;
  vUv = slotOrigin + unit * uAtlasCell;
  vCell = aCell;
}`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uAtlas;
in vec2 vUv;
flat in uvec4 vCell;
out vec4 outColor;
vec4 rgba8(uint c) {
  return vec4(float(c & 255u), float((c >> 8) & 255u), float((c >> 16) & 255u),
              float((c >> 24) & 255u)) / 255.0;
}
void main() {
  vec4 bg = rgba8(vCell.z);
  vec4 fg = rgba8(vCell.y);
  float glyph = texture(uAtlas, vUv).a;
  outColor = mix(bg, vec4(fg.rgb, 1.0), glyph * fg.a);
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

  gl.useProgram(program)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

  /**
   * The occlusion plate: a scissored `clear` of the grid rect expanded by `padPx` world units.
   *
   * A clear, not a blended quad, on purpose — it WRITES the colour (blending is bypassed), which
   * is what makes it occlude rather than tint whatever was drawn beneath. Callers therefore pass
   * an OPAQUE bgColor; a translucent one would punch the frame's alpha down to that value.
   *
   * Two constraints live here and are the easy things to get wrong:
   *  - The scissor rect is in DEVICE pixels (the drawing buffer), never CSS px — hence the
   *    `* dpr`, using the ratio captured at `resize` rather than reading devicePixelRatio now.
   *  - GL's scissor origin is BOTTOM-LEFT while world/CSS Y grows downward, so Y is FLIPPED
   *    against the drawing buffer height: `y = deviceH - (top + height)`.
   */
  // An arrow const, not a `function` declaration: declarations hoist above the `if (!gl) return`
  // narrowing, so `gl` would be `WebGL2RenderingContext | null` inside the body.
  const drawPlate = (g: GridDrawParams): void => {
    // world → screen (CSS px): screen = world * zoom + pan, exactly as the vertex shader does.
    const leftCss = (g.originX - g.padPx) * cam.zoom + cam.x
    const topCss = (g.originY - g.padPx) * cam.zoom + cam.y
    const wCss = (g.cols * g.cellW + 2 * g.padPx) * cam.zoom
    const hCss = (g.rows * g.cellH + 2 * g.padPx) * cam.zoom
    // CSS px → DEVICE px.
    const left = Math.round(leftCss * dpr)
    const top = Math.round(topCss * dpr)
    const width = Math.round(wCss * dpr)
    const height = Math.round(hCss * dpr)
    // Y FLIP: GL scissor origin is bottom-left.
    const bottom = deviceH - (top + height)
    // Clamp to the viewport: a scissor rect is allowed to hang outside it, but clamping keeps
    // the width/height non-negative after the origin is pushed to 0 (a negative extent is a
    // GL_INVALID_VALUE, and an off-screen grid should simply skip the plate).
    const x0 = Math.max(0, left)
    const y0 = Math.max(0, bottom)
    const x1 = Math.min(deviceW, left + width)
    const y1 = Math.min(deviceH, bottom + height)
    if (x1 <= x0 || y1 <= y0) return
    const c = unpackColor(g.bgColor)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(x0, y0, x1 - x0, y1 - y0)
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
    uploadAtlas(source, sizePx, cellW, cellH) {
      gl.bindTexture(gl.TEXTURE_2D, atlasTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      atlasCols = Math.floor(sizePx / cellW)
      atlasCellUv = [cellW / sizePx, cellH / sizePx]
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
      // COPIED, not aliased: the plate math reads this during the drawGrid calls that follow,
      // and a caller mutating its own camera object mid-frame would move grids apart.
      cam = { ...camera }
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(program)
      gl.uniform2f(u('uPan'), camera.x, camera.y)
      gl.uniform1f(u('uZoom'), camera.zoom)
      gl.uniform2f(u('uView'), view[0], view[1])
      gl.uniform1f(u('uAtlasCols'), atlasCols)
      gl.uniform2f(u('uAtlasCell'), atlasCellUv[0], atlasCellUv[1])
      gl.uniform1i(u('uAtlas'), 0)
    },
    drawGrid(g: GridDrawParams) {
      const grid = grids.get(g.id)
      // Never drawn without its own buffer: an unregistered id would otherwise draw whatever
      // buffer happened to be bound from the previous grid.
      if (!grid) return

      // --- (1) the plate: an opaque scissored clear of the grid rect expanded by padPx. It is
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
