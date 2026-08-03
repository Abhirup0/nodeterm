import type { Camera } from './camera'
import { CELL_STRIDE } from './cells'
import type { GlyphGL, GridDraw } from './gl'

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
  const cellBuf = gl.createBuffer()
  const atlasTex = gl.createTexture()
  let atlasCols = 1
  let atlasCellUv: [number, number] = [0, 0]
  let view: [number, number] = [1, 1]

  gl.useProgram(program)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

  return {
    resize(w, h, dpr) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      view = [w, h]
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
    beginFrame(camera: Camera) {
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
    drawGrid(g: GridDraw) {
      // g.bgColor is deliberately NOT read here: in Phase 0 every cell paints its own opaque
      // bg lane in the fragment shader, so a separate background quad would only add overdraw.
      // The field is consumed in Phase 1, where the quad also covers the grid's padding/border
      // (the area outside cols*rows) and is what makes the painter's-algorithm occlusion total.
      gl.uniform2f(u('uGridOrigin'), g.originX, g.originY)
      gl.uniform2f(u('uCell'), g.cellW, g.cellH)
      gl.uniform1f(u('uCols'), g.cols)
      gl.bindBuffer(gl.ARRAY_BUFFER, cellBuf)
      gl.bufferData(gl.ARRAY_BUFFER, g.cells, gl.DYNAMIC_DRAW)
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
      gl.deleteBuffer(cellBuf)
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
