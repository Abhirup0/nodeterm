import { describe, expect, it, vi } from 'vitest'
import { GlyphAtlas } from './atlas'
import { CELL_STRIDE, packColor } from './cells'
import { GlyphGridEngine, type GridSpec } from './engine'
import type { GlyphGL, GridDrawParams } from './gl'

/** [id, cols, rows] as passed to createGrid. */
type Created = [string, number, number]
/** [id, firstRow, rowCount] as passed to uploadRows — the row-range damage assertion. */
type Upload = [string, number, number]

type FakeGL = GlyphGL & {
  drawn: string[]
  created: Created[]
  disposed: string[]
  uploads: Upload[]
  uploaded: Uint32Array[]
  params: GridDrawParams[]
  /** How many times the context rebuilt its GPU objects (`restore`). */
  restores: number
  /** Make the next `restore()` throw — a driver that will not rebuild, which the caller must
   *  answer with a permanent fallback rather than with a retry. */
  failRestore: boolean
}

function fakeGL(): FakeGL {
  const drawn: string[] = []
  const created: Created[] = []
  const disposed: string[] = []
  const uploads: Upload[] = []
  const uploaded: Uint32Array[] = []
  const params: GridDrawParams[] = []
  const self: FakeGL = {
    drawn,
    created,
    disposed,
    uploads,
    uploaded,
    params,
    restores: 0,
    failRestore: false,
    restore: (): void => {
      if (self.failRestore) throw new Error('rebuild failed')
      self.restores++
    },
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
  return self
}

const atlas = () =>
  new GlyphAtlas(
    { cellW: 10, cellH: 20, source: null, draw: () => undefined, clearPage: () => undefined },
    100
  )

/** An atlas whose rasterizer already has a texture source, so the engine can upload it. */
function loadedAtlas(sizePx = 512, cellW = 7, cellH = 15) {
  const source = {} as unknown as TexImageSource
  return {
    source,
    atlas: new GlyphAtlas(
      { cellW, cellH, source, draw: () => undefined, clearPage: () => undefined },
      sizePx
    )
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
    a.glyphFor(0x41, false, false, 0xffffffff, 0xff000000) // dirties the atlas
    expect(e.frame()).toBe(true)
    // The extent stays exact (texel:pixel 1:1 against the quad the grid draws) and the pitch is
    // the whole-texel slot spacing; the shader needs both, and handing it the extent as the pitch
    // would overlap every slot with its neighbour.
    // The pitch now carries a GUTTER_PX margin on each side (16 + 4, 32 + 4) — the ink-free
    // ring the mip chain needs. The extent is unchanged: it is still the exact device cell.
    expect(gl.uploadAtlas).toHaveBeenCalledWith(source, 512, 15.66, 31.2, 20, 36)
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
    a.glyphFor(0x41, false, false, 0xffffffff, 0xff000000)
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

})

/** The wake signal the parked rAF driver resumes on — see `createFrameLoop`. The whole point is
 *  that it fires on the clean→dirty EDGE, so a busy terminal costs one call per frame at most
 *  instead of one per row write. */
describe('onDamage', () => {
  it('fires on the clean→dirty transition and not again while already dirty', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0, 0, { rows: 3 }))
    e.frame() // consume the registration damage — the engine is clean from here
    const woke = vi.fn()
    e.onDamage(woke)
    h.updateRow(0, rowOf(2))
    expect(woke).toHaveBeenCalledTimes(1)
    // Already dirty: sixty row writes before the next frame are still ONE wake.
    h.updateRow(1, rowOf(2))
    h.updateRow(2, rowOf(2))
    e.setCamera({ x: 5, y: 0, zoom: 1 })
    expect(woke).toHaveBeenCalledTimes(1)
  })

  it('fires again after a frame() has cleared the flag', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0, 0, { rows: 3 }))
    e.frame()
    const woke = vi.fn()
    e.onDamage(woke)
    h.updateRow(0, rowOf(2))
    e.frame() // clears the flag
    h.updateRow(1, rowOf(2))
    expect(woke).toHaveBeenCalledTimes(2)
  })

  it('a HIDDEN grid’s updateRow does not fire it', () => {
    // The visibility-scoped damage rule, restated at the wake seam: a hidden grid's write sets
    // only ITS row range, so it must neither dirty the engine nor un-park the driver. Waking the
    // loop for a grid the frame would cull is the exact cost that rule exists to remove.
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(100, 100, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('far', 5000, 0, { rows: 3 }))
    e.frame() // registration damage; the grid is culled, so it is recorded as hidden
    const woke = vi.fn()
    e.onDamage(woke)
    h.updateRow(1, rowOf(2))
    expect(woke).not.toHaveBeenCalled()
    // …and the frame that brings it back into view still wakes, because the camera dirties
    // unconditionally — the leg the whole optimization stands on.
    e.setCamera({ x: -5000, y: 0, zoom: 1 })
    expect(woke).toHaveBeenCalledTimes(1)
  })

  it('stops delivering after the subscription is disposed', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0, 0, { rows: 3 }))
    e.frame()
    const woke = vi.fn()
    const sub = e.onDamage(woke)
    sub.dispose()
    h.updateRow(0, rowOf(2))
    expect(woke).not.toHaveBeenCalled()
  })

  it('restoring damage after a throwing frame wakes the driver again', () => {
    // The damage-restore path in frame()'s catch is a clean→dirty transition like any other: the
    // canvas is half-drawn and owes a redraw, so a PARKED driver has to hear about it.
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('a', 0))
    const woke = vi.fn()
    e.onDamage(woke)
    gl.beginFrame = () => {
      throw new Error('context lost')
    }
    expect(() => e.frame()).toThrow('context lost')
    expect(woke).toHaveBeenCalledTimes(1)
  })
})

describe('plate params', () => {
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
        plateH: 44,
        // A grid registered without a radius plates a SQUARE rect — bit-for-bit the shape every
        // grid had before the plate became a quad, which is what keeps this expectation (and the
        // harness, which registers no radius either) meaning what it always meant.
        plateRadius: 0,
        // A grid nobody has told about a cursor draws none — the overlay pass is skipped whole.
        cursor: null
      }
    ])
  })

  it('carries the plate RADIUS from the spec to drawGrid', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    // WORLD units — the node's own corner radius at zoom 1. The engine neither scales nor clamps
    // it: that is `plateRadiusDevice`'s job, once per draw, because both things it clamps against
    // (the camera and the plate's device extent) are known only at draw time.
    e.register(spec('a', 0, 0, { plateRadius: 9 }))
    e.frame()
    expect(gl.params.at(-1)).toMatchObject({ plateRadius: 9 })
  })
})

/** THE CURSOR OVERLAY — the per-grid spec the GL layer turns into a bar / underline / outline.
 *
 *  The engine's job here is exactly the job it does for the plate: hold the latest value, gate it on
 *  change, and hand it to `drawGrid`. It never computes geometry (that is `cursor.ts`) and never
 *  learns what a shape looks like. */
describe('cursor params', () => {
  const CURSOR = { col: 3, row: 1, shape: 'bar' as const, widthCells: 1, color: 0xff00ffff }

  it('a cursor set on the handle reaches drawGrid', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    h.setCursor(CURSOR)
    e.frame()
    expect(gl.params.at(-1)?.cursor).toEqual(CURSOR)
  })

  it('is change-gated — re-setting the same cursor draws nothing', () => {
    // The caller re-derives this whenever it packs rows (the cursor's position comes from the same
    // buffer state), so an unconditional dirty here would keep the shared canvas redrawing forever
    // — the same discipline as setPlateRect.
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    h.setCursor(CURSOR)
    expect(e.frame()).toBe(true)
    h.setCursor({ ...CURSOR })
    expect(e.frame()).toBe(false)
    // Every field is compared, not just the position: a shape, width or colour change repaints too.
    h.setCursor({ ...CURSOR, col: 4 })
    expect(e.frame()).toBe(true)
    h.setCursor({ ...CURSOR, col: 4, shape: 'underline' })
    expect(e.frame()).toBe(true)
    h.setCursor({ ...CURSOR, col: 4, shape: 'underline', widthCells: 2 })
    expect(e.frame()).toBe(true)
    h.setCursor({ ...CURSOR, col: 4, shape: 'underline', widthCells: 2, color: 1 })
    expect(e.frame()).toBe(true)
  })

  it('clearing it is a change once, and a no-op thereafter', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    h.setCursor(CURSOR)
    e.frame()
    h.setCursor(null)
    expect(e.frame()).toBe(true)
    expect(gl.params.at(-1)?.cursor).toBe(null)
    h.setCursor(null)
    expect(e.frame()).toBe(false)
  })

  it('a HIDDEN grid’s cursor change does not wake the canvas, and rides the frame that reveals it', () => {
    // Visibility-scoped, like updateRow and for the same reason: a cursor moves on every keystroke,
    // and forty-five off-screen terminals typing would each wake the shared canvas for a grid the
    // frame culls anyway. Safe for the same reason too — the cursor is a VALUE on the grid, not a
    // range that could be lost, and every input that can change visibility dirties unconditionally.
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(100, 100, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('far', 5000))
    e.frame() // registration damage; the grid is culled, so it is recorded as hidden
    const woke = vi.fn()
    e.onDamage(woke)
    h.setCursor(CURSOR)
    expect(woke).not.toHaveBeenCalled()
    expect(e.frame()).toBe(false)
    e.setCamera({ x: -5000, y: 0, zoom: 1 })
    expect(e.frame()).toBe(true)
    expect(gl.params.at(-1)?.cursor).toEqual(CURSOR)
  })

  it('setCursor on a disposed handle is inert — it must not un-idle the canvas', () => {
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    h.dispose()
    e.frame()
    h.setCursor(CURSOR)
    expect(e.frame()).toBe(false)
  })
})

/**
 * SUSPEND / REVIVE — surviving a lost GPU context.
 *
 * The whole design rests on one distinction: a lost context takes the GPU OBJECTS, never the
 * REGISTRY. Each grid's spec, its CPU-side cells and its z survive, so the handles the terminal
 * nodes hold stay valid across the entire cycle and nobody has to re-register. That is what makes
 * a restore a repaint rather than a rebuild of the whole integration.
 */
describe('suspendGpu / reviveGpu', () => {
  it('keeps its registry across a suspend/revive and repaints everything after', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    expect(e.frame()).toBe(true) // registration damage
    expect(e.frame()).toBe(false) // settled

    e.suspendGpu()
    expect(gl.disposed).toContain('a')

    e.reviveGpu()
    // Created once at register, once at revive — the SAME id, i.e. the registry entry survived.
    expect(gl.created.map((c) => c[0])).toEqual(['a', 'a'])
    expect(gl.restores).toBe(1)
    // Everything is dirty again: the fresh buffers are zeroed, so the first frame owes the GPU
    // every row of every grid.
    expect(e.frame()).toBe(true)
    expect(gl.uploads.at(-1)).toEqual(['a', 0, 1])

    // The handle the node holds is still the live one — a write through it still reaches the
    // canvas, with no re-registration anywhere.
    h.updateRow(0, rowOf(2))
    expect(e.frame()).toBe(true)
  })

  it('submits NO frame while suspended, however much damage arrives', () => {
    // The constraint the whole cycle stands on: between the loss and the restore there are no GPU
    // objects, so a frame would draw against deleted buffers — and the driver's catch would read
    // the throw as a GPU failure and burn the session that is in the middle of recovering.
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0))
    e.frame()
    e.suspendGpu()
    const before = gl.drawn.length
    h.updateRow(0, rowOf(2))
    expect(e.frame()).toBe(false)
    expect(gl.drawn.length).toBe(before)
  })

  it('does not wake the canvas on suspend — the loop is being parked, not started', () => {
    // `markDirty` is the wake signal, and waking here would schedule a frame against the context
    // that has just gone away.
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('a', 0))
    e.frame()
    const woke = vi.fn()
    e.onDamage(woke)
    e.suspendGpu()
    expect(woke).not.toHaveBeenCalled()
  })

  it('replays the rows written while suspended — deferred, never lost', () => {
    // The addons keep packing rows through the whole outage (nothing tells them the GPU went
    // away), and those writes land in the CPU-side cells like any other. The revive owes the GPU
    // all of them.
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    const h = e.register(spec('a', 0, 0, { rows: 2, plateH: 40 }))
    e.frame()
    e.suspendGpu()
    const row = rowOf(2)
    row[0] = 7
    h.updateRow(1, row)
    e.reviveGpu()
    e.frame()
    expect(gl.uploads.at(-1)).toEqual(['a', 0, 2])
    expect(gl.uploaded.at(-1)?.at(CELL_STRIDE * 2)).toBe(7)
  })

  it('re-uploads the atlas after a revive — the texture died with the context', () => {
    const gl = fakeGL()
    const { atlas: loaded } = loadedAtlas()
    const e = new GlyphGridEngine(gl, loaded)
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('a', 0))
    e.frame()
    expect(gl.drawn.filter((d) => d === 'ATLAS')).toHaveLength(1)
    e.suspendGpu()
    e.reviveGpu()
    e.frame()
    expect(gl.drawn.filter((d) => d === 'ATLAS')).toHaveLength(2)
  })

  it('a revive without a suspend changes nothing — a stray restore must not double-create', () => {
    // `webglcontextrestored` can arrive for a context we never suspended (a browser that restores
    // on its own after we have already given up). Rebuilding there would allocate a second buffer
    // per grid and leak the first.
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('a', 0))
    e.frame()
    e.reviveGpu()
    expect(gl.created).toHaveLength(1)
    expect(gl.restores).toBe(0)
  })

  it('a throwing restore leaves the engine suspended, so nothing draws against a dead context', () => {
    // The caller answers a throw with the permanent fallback; the engine's job is only to stay
    // safe if it does not — never to retry the rebuild itself.
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('a', 0))
    e.frame()
    e.suspendGpu()
    gl.failRestore = true
    expect(() => e.reviveGpu()).toThrow()
    // No grid was re-created, and the frame gate is still shut.
    expect(gl.created).toHaveLength(1)
    expect(e.frame()).toBe(false)
  })

  it('reports whether it is suspended — the layer\'s mount guard reads this', () => {
    // The engine is a module singleton and the restore policy is scoped to a React effect, so a
    // mount landing on a suspended engine is the one case no policy is waiting for. Nothing else
    // can detect it.
    const e = new GlyphGridEngine(fakeGL(), atlas())
    e.setViewport(800, 600, 1)
    e.register(spec('a', 0))
    expect(e.gpuIsSuspended()).toBe(false)
    e.suspendGpu()
    expect(e.gpuIsSuspended()).toBe(true)
    e.reviveGpu()
    expect(e.gpuIsSuspended()).toBe(false)
  })

  it('a second suspend is a no-op — the buffers are already gone', () => {
    const gl = fakeGL()
    const e = new GlyphGridEngine(gl, atlas())
    e.setViewport(800, 600, 1)
    e.setCamera({ x: 0, y: 0, zoom: 1 })
    e.register(spec('a', 0))
    e.suspendGpu()
    e.suspendGpu()
    expect(gl.disposed).toEqual(['a'])
  })
})
