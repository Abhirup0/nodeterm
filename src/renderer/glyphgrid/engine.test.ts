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
      // Recorded in the SAME log as the draws: a grid's rows must reach its GPU buffer before
      // the drawGrid that reads them, or that frame draws the previous contents. Two separate
      // logs could not express the interleaving, which is the only thing being asserted.
      drawn.push(`UP:${id}`)
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

/** A 2×1 grid of 10×20 cells → a 20×20 cell rect at (x, 0). The plate DEFAULTS to exactly that
 *  rect, so a test that says nothing about the plate reads as if the two coincided; the tests that
 *  care about the two being different rects pass their own `plate*`. */
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
  plateX: x,
  plateY: 0,
  plateW: 20,
  plateH: 20,
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

  it('culls against the plate rect: a grid whose plate alone overlaps the viewport is drawn', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(100, 100, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    // Cells start exactly at the right viewport edge (x=100, visible world rect is 0..100), so
    // the character matrix alone is off-screen — but the plate is the node's opaque BODY and
    // reaches further left, into view. Culling on the cell rect would leave a visible strip of
    // node body unpainted at every viewport edge, and would skip the plate that occludes whatever
    // sits underneath it.
    e.register(spec('plated', 100, 0, { plateX: 92, plateW: 36 }))
    e.register(spec('bare', 100, 0))
    expect(e.drawOrder()).toEqual(['plated'])
  })

  it('culls against the CELL rect too: a grid whose cells alone overlap the viewport is drawn', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(100, 100, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    // The other half of the union, and the reason it is a union rather than "the plate contains
    // the grid, so test the plate". Nothing structurally guarantees containment — the two rects
    // are pushed by different observers (`setOrigin` follows .xterm-screen, `setPlateRect` the
    // body box), so mid-resize a stale plate can sit off-screen while the cells are in plain
    // view. Culling on the plate alone would blank a visible terminal.
    e.register(spec('cells-only', 90, 0, { plateX: 500, plateY: 500 }))
    expect(e.drawOrder()).toEqual(['cells-only'])
  })

  it('culls a grid whose plate AND cells are both off-screen', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(100, 100, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    // The union must not be a BOUNDING BOX of the two rects: the box spanning (500,0)-(520,20)
    // and (0,500)-(20,520) covers the origin, so a bounding-box union would keep drawing a grid
    // that paints no pixel at all.
    e.register(spec('gone', 500, 0, { plateX: 0, plateY: 500 }))
    expect(e.drawOrder()).toEqual([])
  })

  it('setPlateRect moves the plate, change-gated like every other mutator', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    e.frame()
    // Same rect → nothing changed on screen. The caller is a ResizeObserver firing on every
    // layout tick, so an unconditional dirty here would keep the shared canvas redrawing forever.
    h.setPlateRect(0, 0, 20, 20)
    expect(e.frame()).toBe(false)
    h.setPlateRect(-6, -4, 40, 44)
    expect(e.frame()).toBe(true)
  })

  it('setPlateRect on a disposed handle is inert — it must not un-idle the canvas', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    h.dispose()
    e.frame()
    h.setPlateRect(-6, -4, 40, 44)
    expect(e.frame()).toBe(false)
  })

  it('a plate change reaches drawGrid', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    e.frame()
    h.setPlateRect(-6, -4, 40, 44)
    e.frame()
    expect(gl.params.at(-1)).toMatchObject({ plateX: -6, plateY: -4, plateW: 40, plateH: 44 })
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
    // The upload pass runs to completion BEFORE beginFrame — see the upload-before-draw test.
    expect(gl.drawn).toEqual(['UP:bottom', 'UP:top', 'BEGIN', 'grid@0,0', 'grid@10,0', 'END'])
  })

  it('a visible dirty grid uploads its rows before the draw that reads them', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0, 0, { rows: 3 }))
    e.frame() // consume the registration upload
    gl.drawn.length = 0
    h.updateRow(1, rowOf(2))
    e.frame()
    // Ordering, not mere presence: drawGrid reads the grid's own GPU buffer, so an upload landing
    // after it would paint the PREVIOUS frame's rows and only correct itself on the next damage —
    // a one-frame-stale terminal that no per-call assertion can see.
    expect(gl.drawn.indexOf('UP:a')).toBeGreaterThanOrEqual(0)
    expect(gl.drawn.indexOf('UP:a')).toBeLessThan(gl.drawn.indexOf('grid@0,0'))
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
    // A FRACTIONAL cell on purpose — that is what xterm reports (`charWidth * dpr`), and it is the
    // only shape in which conflating the sampled EXTENT with the slot PITCH is observable: with an
    // integer cell the two are equal, so passing either number for the other would pass.
    const { atlas: a, source } = loadedAtlas(512, 15.66, 31.2)
    const e = new GlyphGridEngine(gl, a)
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('a', 0))
    a.glyphFor(0x41, false, false) // dirties the atlas
    expect(e.frame()).toBe(true)
    // The extent stays exact (texel:pixel 1:1 against the quad the grid draws) and the pitch is
    // the whole-texel slot spacing; the shader needs both, and handing it the extent as the pitch
    // would overlap every slot with its neighbour.
    expect(gl.uploadAtlas).toHaveBeenCalledWith(source, 512, 15.66, 31.2, 16, 32)
    // Stronger than "before the first drawGrid": beginFrame pushes uAtlasCols/uAtlasCell from
    // the values uploadAtlas stored, so an upload landing after it would leave frame 1 sampling
    // slot 0 everywhere and the uniforms permanently one upload stale.
    // Self-sufficiency first: indexOf returns -1 for a MISSING entry, and -1 is less than every
    // real index — so without this the two comparisons below would pass just as happily if the
    // atlas upload had never been recorded at all.
    expect(gl.drawn.indexOf('ATLAS')).toBeGreaterThanOrEqual(0)
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

  it('disposeAll frees every grid, empties the draw order and leaves outstanding handles inert', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const a = e.register(spec('a', 0))
    const b = e.register(spec('b', 40))
    e.frame()
    e.disposeAll()
    // Every GPU buffer freed, in registration order — the layer's teardown / context-loss path.
    expect(gl.disposed).toEqual(['a', 'b'])
    expect(e.drawOrder()).toEqual([])
    // Teardown IS damage: the canvas still holds their pixels until something redraws it.
    expect(e.frame()).toBe(true)

    gl.created.length = 0
    gl.uploads.length = 0
    // Every handle handed out before the sweep must be as inert as one whose own dispose() ran —
    // a torn-down owner's last writes are a teardown race, and they must neither resurrect a dead
    // grid nor keep the shared canvas redrawing for a grid nobody draws.
    a.updateRow(0, rowOf(2))
    a.setOrigin(99, 99)
    b.setZ(42)
    b.resize(4, 4)
    expect(e.frame()).toBe(false)
    expect(gl.created).toEqual([])
    expect(gl.uploads).toEqual([])

    // A stale handle's own dispose() must not double-free a buffer the sweep already released.
    a.dispose()
    expect(gl.disposed).toEqual(['a', 'b'])
    // Idempotent, and an empty sweep is not damage (same change-gating as setCamera/setViewport).
    e.disposeAll()
    expect(gl.disposed).toEqual(['a', 'b'])
    expect(e.frame()).toBe(false)
  })

  it("a stale handle's resize after disposeAll allocates no GPU buffer", () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    e.frame()
    e.disposeAll()
    gl.created.length = 0
    // resize's caller is a size observer that fires on every layout tick, so it is the mutator
    // most likely to arrive after teardown. createGrid here would allocate a buffer the registry
    // no longer tracks — nothing would ever dispose it.
    h.resize(9, 9)
    e.frame()
    expect(gl.created).toEqual([])
    expect(e.drawOrder()).toEqual([])
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

  it('a hidden grid defers its upload until it becomes visible, and its writes never wake the engine', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(100, 100, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('far', 5000, 0, { rows: 3 }))
    expect(e.frame()).toBe(true) // registration dirties the engine, but the grid is culled…
    expect(gl.uploads).toEqual([]) // …so nothing uploads, and that frame recorded it as hidden
    h.updateRow(1, rowOf(2))
    // Visibility-scoped damage: a hidden grid's write sets ITS range but must NOT schedule a
    // full-canvas redraw. Forty-five hidden streaming terminals each waking the shared canvas is
    // the cost this exists to remove — the frame they woke drew nothing of theirs anyway.
    expect(e.frame()).toBe(false)
    expect(gl.uploads).toEqual([]) // still off-screen: the range persists, un-uploaded
    // Panning dirties unconditionally — the invariant that makes the optimization safe: the only
    // things that can CHANGE visibility all dirty, so a grid entering view always gets a frame in
    // which to replay what it deferred.
    e.setCamera({ x: -5000, y: 0, zoom: 1 })
    expect(e.frame()).toBe(true)
    // Everything owed since registration, in ONE upload — not one per deferred frame.
    expect(gl.uploads).toEqual([['far', 0, 3]])
    expect(e.frame()).toBe(false)
    expect(gl.uploads).toHaveLength(1)
  })

  it('a visible grid keeps waking the engine on every row write', () => {
    // The other half of the visibility gate: scoping damage must not make a terminal the user is
    // LOOKING at go quiet. (`spec('a', 0)` sits under the camera.)
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0, 0, { rows: 3 }))
    e.frame()
    h.updateRow(1, rowOf(2))
    expect(e.frame()).toBe(true)
    h.updateRow(2, rowOf(2))
    expect(e.frame()).toBe(true)
  })

  it('a grid scrolled OUT of view stops waking the engine', () => {
    // Visibility is re-read at every drawOrder() computation, not latched at registration.
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(100, 100, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0, 0, { rows: 3 }))
    e.frame()
    e.setCamera({ x: 5000, y: 0, zoom: 1 }) // pan it off-screen
    e.frame()
    h.updateRow(1, rowOf(2))
    expect(e.frame()).toBe(false)
  })

  it('drawGrid receives the plate params (bgColor + plate rect) with the grid geometry', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const bg = packColor(20, 20, 24, 255)
    // A plate that is NOT the cell rect — the body overhangs the matrix by 6 left/top and leaves
    // fit slack right/bottom, which is the shape every real terminal has.
    e.register(spec('a', 0, 0, { bgColor: bg, plateX: -6, plateY: -4, plateW: 40, plateH: 44 }))
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
        plateX: -6,
        plateY: -4,
        plateW: 40,
        plateH: 44
      }
    ])
  })
})
