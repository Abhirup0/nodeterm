import { describe, expect, it, vi } from 'vitest'
import { GlyphAtlas } from './atlas'
import { CELL_STRIDE } from './cells'
import { GlyphGridEngine, type GridSpec } from './engine'
import type { GlyphGL, GridDraw } from './gl'

function fakeGL(): GlyphGL & { drawn: string[] } {
  const drawn: string[] = []
  return {
    drawn,
    resize: vi.fn(),
    // Recorded in `drawn` too: the atlas upload MUST land before beginFrame (which pushes the
    // atlas uniforms), let alone before any drawGrid of the same frame — otherwise the shader
    // samples an incomplete texture (solid blocks) with stale metrics.
    uploadAtlas: vi.fn(() => {
      drawn.push('ATLAS')
    }),
    beginFrame: () => drawn.push('BEGIN'),
    drawGrid: (g: GridDraw & { id?: string }) => drawn.push(`grid@${g.originX},${g.originY}`),
    endFrame: () => drawn.push('END'),
    dispose: vi.fn()
  }
}

const atlas = () =>
  new GlyphAtlas({ cellW: 10, cellH: 20, source: null, draw: () => undefined }, 100)

/** An atlas whose rasterizer already has a texture source, so the engine can upload it. */
function loadedAtlas(sizePx = 512, cellW = 7, cellH = 15) {
  const source = {} as unknown as TexImageSource
  return {
    source,
    atlas: new GlyphAtlas({ cellW, cellH, source, draw: () => undefined }, sizePx)
  }
}

const spec = (id: string, x: number, z = 0): GridSpec => ({
  id,
  cols: 2,
  rows: 1,
  cellW: 10,
  cellH: 20,
  originX: x,
  originY: 0,
  z,
  bgColor: 0
})

describe('GlyphGridEngine', () => {
  it('an idle engine draws nothing; a dirty grid draws exactly one frame', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    expect(e.frame()).toBe(true) // registration dirties
    expect(e.frame()).toBe(false) // idle → no draw
    h.updateRow(0, new Uint32Array(2 * CELL_STRIDE))
    expect(e.frame()).toBe(true)
    expect(e.frame()).toBe(false)
  })

  it('camera movement dirties the frame', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.register(spec('a', 0))
    e.frame()
    e.setCamera({ x: 1, y: 0, zoom: 1 })
    expect(e.frame()).toBe(true)
  })

  it('an unchanged camera does not dirty the frame', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 3, y: 4, zoom: 2 })
    e.register(spec('a', 0))
    e.frame()
    e.setCamera({ x: 3, y: 4, zoom: 2 })
    expect(e.frame()).toBe(false)
  })

  it('culls grids outside the visible world rect', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(100, 100, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('in', 0))
    e.register(spec('out', 5000))
    expect(e.drawOrder()).toEqual(['in'])
  })

  it('draws in z order ascending, ties by registration order', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('bottom', 0, 0))
    e.register(spec('top', 10, 5))
    e.register(spec('mid', 20, 2))
    expect(e.drawOrder()).toEqual(['bottom', 'mid', 'top'])
  })

  it('frame() submits the visible grids in draw order, between begin and end', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('bottom', 0, 0))
    e.register(spec('top', 10, 5))
    e.register(spec('offscreen', 5000, 1))
    e.frame()
    expect(gl.drawn).toEqual(['BEGIN', 'grid@0,0', 'grid@10,0', 'END'])
  })

  it('updateRow rejects a wrong-length row', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    const h = e.register(spec('a', 0))
    expect(() => h.updateRow(0, new Uint32Array(3))).toThrow(/row length/)
  })

  it('updateRow rejects an out-of-range row', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    const h = e.register(spec('a', 0)) // rows: 1
    expect(() => h.updateRow(1, new Uint32Array(2 * CELL_STRIDE))).toThrow(/row 1/)
  })

  it('updateRow writes row-major: cellIndex = row * cols + col', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register({ ...spec('a', 0), rows: 3 })
    const row = new Uint32Array(2 * CELL_STRIDE)
    row[0] = 0xaa // row 1, col 0 → cellIndex 2
    row[CELL_STRIDE] = 0xbb // row 1, col 1 → cellIndex 3
    h.updateRow(1, row)
    let submitted: Uint32Array | null = null
    gl.drawGrid = (g) => {
      submitted = g.cells
    }
    e.frame()
    const cells = submitted as unknown as Uint32Array
    expect(cells[2 * CELL_STRIDE]).toBe(0xaa)
    expect(cells[3 * CELL_STRIDE]).toBe(0xbb)
  })

  it('setOrigin / setZ dirty only on a real change', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0, 1))
    e.frame()
    h.setOrigin(0, 0)
    h.setZ(1)
    expect(e.frame()).toBe(false)
    h.setOrigin(40, 0)
    expect(e.frame()).toBe(true)
    h.setZ(2)
    expect(e.frame()).toBe(true)
  })

  it('resize reshapes the cell buffer and dirties', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    e.frame()
    h.resize(5, 2)
    expect(e.frame()).toBe(true)
    // The new shape is what updateRow validates against now.
    expect(() => h.updateRow(1, new Uint32Array(5 * CELL_STRIDE))).not.toThrow()
    expect(() => h.updateRow(0, new Uint32Array(2 * CELL_STRIDE))).toThrow(/row length/)
  })

  it('dispose removes the grid from the draw order', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    h.dispose()
    expect(e.drawOrder()).toEqual([])
  })

  it('refuses a duplicate id instead of silently replacing a live grid', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.register(spec('a', 0))
    expect(() => e.register(spec('a', 10))).toThrow(/already registered/)
  })

  it('uploads the atlas with the rasterizer metrics before beginFrame', () => {
    const gl = fakeGL()
    const { atlas: a, source } = loadedAtlas(512, 7, 15)
    const e = new GlyphGridEngine(gl, a)
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('a', 0))
    a.glyphFor(0x41, false, false) // dirties the atlas
    expect(e.frame()).toBe(true)
    expect(gl.uploadAtlas).toHaveBeenCalledWith(source, 512, 7, 15)
    // Stronger than "before the first drawGrid": beginFrame pushes uAtlasCols/uAtlasCell from
    // the values uploadAtlas stored, so an upload landing after it would leave frame 1 sampling
    // slot 0 everywhere and the uniforms permanently one upload stale.
    expect(gl.drawn.indexOf('ATLAS')).toBeLessThan(gl.drawn.indexOf('BEGIN'))
    expect(gl.drawn.indexOf('ATLAS')).toBeLessThan(gl.drawn.indexOf('grid@0,0'))
    expect(a.dirty).toBe(false)
  })

  it('uploads a never-uploaded atlas even when it is not dirty, and only once', () => {
    const gl = fakeGL()
    const { atlas: a } = loadedAtlas()
    a.glyphFor(0x41, false, false)
    a.clearDirty() // rasterized elsewhere: has content, reports clean
    const e = new GlyphGridEngine(gl, a)
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('a', 0))
    expect(e.frame()).toBe(true)
    expect(gl.uploadAtlas).toHaveBeenCalledTimes(1)
    e.setCamera({ x: 1, y: 0, zoom: 1 })
    expect(e.frame()).toBe(true)
    expect(gl.uploadAtlas).toHaveBeenCalledTimes(1) // clean + already uploaded → no re-upload
  })

  it('draws a frame as soon as a pending atlas upload appears, and never uploads a null source', () => {
    const gl = fakeGL()
    const { atlas: a } = loadedAtlas()
    const e = new GlyphGridEngine(gl, a)
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    expect(e.frame()).toBe(true) // pending upload counts as damage
    expect(gl.uploadAtlas).toHaveBeenCalledTimes(1)
    expect(e.frame()).toBe(false)

    const gl2 = fakeGL()
    const e2 = new GlyphGridEngine(gl2, atlas()) // source: null
    e2.setViewport(800, 600, 1)
    e2.setCamera({ x: 0, y: 0, zoom: 1 })
    e2.register(spec('a', 0))
    e2.frame()
    expect(gl2.uploadAtlas).not.toHaveBeenCalled()
  })

  it('setViewport sizes the GL surface and dirties', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('a', 0))
    e.frame()
    e.setViewport(640, 480, 2)
    expect(gl.resize).toHaveBeenCalledWith(640, 480, 2)
    expect(e.frame()).toBe(true)
  })
})

describe('lifecycle hardening', () => {
  it('a disposed handle is inert: writes do nothing and create no damage', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    e.frame() // consume registration damage
    h.dispose()
    e.frame() // consume dispose damage
    h.updateRow(0, new Uint32Array(2 * CELL_STRIDE))
    h.setOrigin(99, 99)
    h.setZ(42)
    h.resize(4, 4)
    expect(e.frame()).toBe(false) // nothing woke the engine
  })

  it('setViewport with identical (w, h, dpr) is a no-op; a dpr change alone dirties', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 2)
    e.frame()
    e.setViewport(800, 600, 2)
    expect(e.frame()).toBe(false)
    e.setViewport(800, 600, 3) // dpr-only change must still resize + dirty
    expect(e.frame()).toBe(true)
  })

  it('same-shape resize is a no-op (content preserved, no damage)', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    e.frame()
    h.resize(2, 1) // same shape as spec()
    expect(e.frame()).toBe(false)
  })

  it('a throwing GL submission does not lose damage', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('a', 0))
    const boom = new Error('context lost mid-frame')
    ;(gl as { beginFrame: unknown }).beginFrame = () => {
      throw boom
    }
    expect(() => e.frame()).toThrow(boom)
    ;(gl as { beginFrame: unknown }).beginFrame = () => undefined
    expect(e.frame()).toBe(true) // damage was restored, next frame redraws
  })
})
