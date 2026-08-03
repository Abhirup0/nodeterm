import { describe, expect, it, vi } from 'vitest'
import { GlyphAtlas } from './atlas'
import { CELL_STRIDE, packColor } from './cells'
import { GlyphGridEngine, type GridSpec } from './engine'
import type { GlyphGL, GridDrawParams } from './gl'

/** [id, cols, rows] as passed to createGrid. */
type Created = [string, number, number]
/** [id, firstRow, rowCount] as passed to uploadRows — the row-range damage assertion. */
type Upload = [string, number, number]

function fakeGL(): GlyphGL & {
  drawn: string[]
  created: Created[]
  disposed: string[]
  uploads: Upload[]
  uploaded: Uint32Array[]
  params: GridDrawParams[]
} {
  const drawn: string[] = []
  const created: Created[] = []
  const disposed: string[] = []
  const uploads: Upload[] = []
  const uploaded: Uint32Array[] = []
  const params: GridDrawParams[] = []
  return {
    drawn,
    created,
    disposed,
    uploads,
    uploaded,
    params,
    resize: vi.fn(),
    // Recorded in `drawn` too: the atlas upload MUST land before beginFrame (which pushes the
    // atlas uniforms), let alone before any drawGrid of the same frame — otherwise the shader
    // samples an incomplete texture (solid blocks) with stale metrics.
    uploadAtlas: vi.fn(() => {
      drawn.push('ATLAS')
    }),
    createGrid: (id, cols, rows) => {
      created.push([id, cols, rows])
    },
    disposeGrid: (id) => {
      disposed.push(id)
    },
    uploadRows: (id, firstRow, rowCount, _cols, cells) => {
      uploads.push([id, firstRow, rowCount])
      // COPIED: the engine hands over a live subarray VIEW of its CPU-side cells, so a later
      // updateRow would rewrite what an earlier assertion is still looking at.
      uploaded.push(new Uint32Array(cells))
    },
    beginFrame: () => drawn.push('BEGIN'),
    drawGrid: (g: GridDrawParams) => {
      params.push({ ...g })
      drawn.push(`grid@${g.originX},${g.originY}`)
    },
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

const spec = (id: string, x: number, z = 0, over: Partial<GridSpec> = {}): GridSpec => ({
  id,
  cols: 2,
  rows: 1,
  cellW: 10,
  cellH: 20,
  originX: x,
  originY: 0,
  z,
  bgColor: 0,
  padPx: 0,
  ...over
})

/** A zeroed row buffer of the right length for a `cols`-wide grid. */
const rowOf = (cols: number): Uint32Array => new Uint32Array(cols * CELL_STRIDE)

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
    const h = e.register(spec('a', 0, 0, { rows: 3 }))
    const row = new Uint32Array(2 * CELL_STRIDE)
    row[0] = 0xaa // row 1, col 0 → cellIndex 2
    row[CELL_STRIDE] = 0xbb // row 1, col 1 → cellIndex 3
    h.updateRow(1, row)
    // Cell data reaches the GPU through uploadRows now, not drawGrid. Registration already
    // marked all three rows dirty, so this frame uploads the range [0..2] — i.e. the whole
    // grid, indexed from its origin, which is exactly what the row-major claim is about.
    e.frame()
    expect(gl.uploads).toEqual([['a', 0, 3]])
    const cells = gl.uploaded[0]
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

  it('a disposed handle never touches the GPU again', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    e.frame()
    h.dispose()
    gl.created.length = 0
    gl.uploads.length = 0
    // A resize on a dead handle must not reallocate a GPU buffer for a grid nobody draws, and
    // a late row write must not queue an upload against a disposed id.
    h.resize(9, 9)
    h.updateRow(0, rowOf(2))
    e.frame()
    expect(gl.created).toEqual([])
    expect(gl.uploads).toEqual([])
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

  it('a throwing uploadRows keeps the grid range pending', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0, 0, { rows: 3 }))
    e.frame() // consume the registration upload
    gl.uploads.length = 0
    h.updateRow(2, rowOf(2))
    const boom = new Error('context lost mid-upload')
    const ok = gl.uploadRows
    gl.uploadRows = () => {
      throw boom
    }
    expect(() => e.frame()).toThrow(boom)
    gl.uploadRows = ok
    // The range is cleared only AFTER uploadRows returns, so the row that never reached the
    // GPU is still owed — a range dropped here would leave that row stale forever.
    expect(e.frame()).toBe(true)
    expect(gl.uploads).toEqual([['a', 2, 1]])
  })
})

describe('per-grid buffers + row-range damage', () => {
  it('register creates the GPU grid; dispose disposes it', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    const h = e.register(spec('a', 0))
    expect(gl.created).toEqual([['a', 2, 1]])
    h.dispose()
    expect(gl.disposed).toEqual(['a'])
  })

  it('a single-row update uploads exactly that row, once', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0, 0, { rows: 3 }))
    e.frame() // registration uploads all rows once
    gl.uploads.length = 0
    h.updateRow(1, rowOf(2))
    e.frame()
    expect(gl.uploads).toEqual([['a', 1, 1]]) // firstRow 1, rowCount 1 — not the whole grid
    e.frame()
    expect(gl.uploads).toHaveLength(1) // clean → no re-upload
  })

  it('two touched rows coalesce into one contiguous range', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0, 0, { rows: 3 }))
    e.frame()
    gl.uploads.length = 0
    h.updateRow(0, rowOf(2))
    h.updateRow(2, rowOf(2))
    e.frame()
    // Contiguous-range policy: rows 0 and 2 widen ONE span that swallows the untouched row 1.
    // One slightly-too-wide bufferSubData beats two calls — a terminal's damage is a run.
    expect(gl.uploads).toEqual([['a', 0, 3]])
  })

  it('a hidden grid defers its upload until it becomes visible', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(100, 100, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('far', 5000, 0, { rows: 3 }))
    e.frame() // registration dirties the engine, but the grid is culled → nothing uploaded
    expect(gl.uploads).toEqual([])
    h.updateRow(1, rowOf(2))
    e.frame()
    expect(gl.uploads).toEqual([]) // still off-screen: the range persists, un-uploaded
    e.setCamera({ x: -5000, y: 0, zoom: 1 }) // pan it into view
    e.frame()
    // Everything owed since registration, in ONE upload — not one per deferred frame.
    expect(gl.uploads).toEqual([['far', 0, 3]])
    e.frame()
    expect(gl.uploads).toHaveLength(1)
  })

  it('drawGrid receives the plate params (bgColor, padPx) with the grid geometry', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const bg = packColor(20, 20, 24, 255)
    e.register(spec('a', 0, 0, { bgColor: bg, padPx: 8 }))
    e.frame()
    // Exact object: cell DATA must NOT travel here any more — it lives in the grid's own GPU
    // buffer, and re-sending it per draw is the ~90 MB/s this task exists to remove.
    expect(gl.params).toEqual([
      {
        id: 'a',
        cols: 2,
        rows: 1,
        cellW: 10,
        cellH: 20,
        originX: 0,
        originY: 0,
        bgColor: bg,
        padPx: 8
      }
    ])
  })
})
