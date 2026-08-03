import type { GlyphAtlas } from './atlas'
import { rectsIntersect, visibleWorldRect, type Camera, type Rect } from './camera'
import { CELL_STRIDE } from './cells'
import type { GlyphGL } from './gl'

/** One registered grid: a cols×rows character matrix placed in world space. `z` is the node
 *  stacking order — grids are drawn ASCENDING (painter's algorithm), so a higher z lands on
 *  top. */
export interface GridSpec {
  id: string
  cols: number
  rows: number
  /** cell size in world units (CSS px at zoom 1) */
  cellW: number
  cellH: number
  /** world position of the grid's top-left corner */
  originX: number
  originY: number
  z: number
  bgColor: number
}

export interface GridHandle {
  /**
   * Replace one row of cells. `cells` is exactly `cols * CELL_STRIDE` lanes laid out per
   * cells.ts ([glyph, fg, bg, flags] per cell) and is COPIED, so the caller may reuse its
   * scratch buffer. Marks the engine dirty.
   *
   * The glyph lane must be a slot obtained from `GlyphAtlas.glyphFor(code, bold, italic)` —
   * never a raw code point. The atlas owns the slot space (0 is the permanently blank slot,
   * and an unrasterized code degrades to it), so a code point written here would sample an
   * arbitrary neighbouring glyph.
   */
  updateRow(row: number, cells: Uint32Array): void
  setOrigin(x: number, y: number): void
  setZ(z: number): void
  resize(cols: number, rows: number): void
  dispose(): void
}

interface Grid extends GridSpec {
  /** Row-major: the cell at (row, col) starts at lane `(row * cols + col) * CELL_STRIDE`.
   *  This is the layout the instanced shader binds — see gl.ts / gl-webgl2.ts. */
  cells: Uint32Array
  seq: number // registration order — the z tie-break
}

/**
 * The renderer's brain: a registry of grids, damage tracking, culling and z-ordered submission.
 *
 * Two contracts the rest of the engine depends on:
 * - **Idle frames cost nothing.** `frame()` draws only when something actually changed and
 *   reports whether it drew, so the rAF driver (and the tests) can prove an untouched canvas
 *   issues zero GL calls.
 * - **The atlas is uploaded before the first `drawGrid` of a frame.** A draw that samples a
 *   texture the glyphs have not been uploaded into paints solid blocks; the engine is the only
 *   place that sees both, so it is the enforcer.
 */
export class GlyphGridEngine {
  private grids = new Map<string, Grid>()
  private camera: Camera = { x: 0, y: 0, zoom: 1 }
  private viewW = 1
  private viewH = 1
  private dirty = false
  private seq = 0
  /** False until an atlas source has actually reached the GPU — see `atlasUploadPending`. */
  private atlasUploaded = false

  constructor(
    private gl: GlyphGL,
    private atlas: GlyphAtlas
  ) {}

  register(spec: GridSpec): GridHandle {
    if (this.grids.has(spec.id))
      throw new Error(`glyphgrid: grid "${spec.id}" already registered — dispose it first`)
    const grid: Grid = {
      ...spec,
      cells: new Uint32Array(spec.cols * spec.rows * CELL_STRIDE),
      seq: this.seq++
    }
    this.grids.set(spec.id, grid)
    this.dirty = true
    const engine = this
    return {
      updateRow(row, cells) {
        if (row < 0 || row >= grid.rows)
          throw new Error(`glyphgrid: row ${row} out of range (rows=${grid.rows})`)
        if (cells.length !== grid.cols * CELL_STRIDE)
          throw new Error(`glyphgrid: row length ${cells.length} != ${grid.cols * CELL_STRIDE}`)
        grid.cells.set(cells, row * grid.cols * CELL_STRIDE)
        engine.dirty = true
      },
      setOrigin(x, y) {
        if (grid.originX === x && grid.originY === y) return
        grid.originX = x
        grid.originY = y
        engine.dirty = true
      },
      setZ(z) {
        if (grid.z === z) return
        grid.z = z
        engine.dirty = true
      },
      resize(cols, rows) {
        // A same-shape resize is a no-op, not a realloc: resize callers are size observers
        // that fire on every layout tick, and reallocating + dirtying there would keep the
        // canvas redrawing forever.
        if (grid.cols === cols && grid.rows === rows) return
        // Content is re-fed by the owner after a real shape change; carrying old cells over
        // it would misalign every row.
        grid.cols = cols
        grid.rows = rows
        grid.cells = new Uint32Array(cols * rows * CELL_STRIDE)
        engine.dirty = true
      },
      dispose() {
        // Identity-checked: only drop the map entry if it is still THIS grid, so a stale
        // handle can never evict a grid that re-registered under the same id.
        if (engine.grids.get(grid.id) !== grid) return
        engine.grids.delete(grid.id)
        engine.dirty = true
      }
    }
  }

  setCamera(cam: Camera): void {
    if (cam.x === this.camera.x && cam.y === this.camera.y && cam.zoom === this.camera.zoom) return
    this.camera = { ...cam }
    this.dirty = true
  }

  setViewport(w: number, h: number, dpr: number): void {
    this.viewW = w
    this.viewH = h
    this.gl.resize(w, h, dpr)
    this.dirty = true
  }

  /** Visible grid ids in draw order (z ascending, ties by registration order). Pure. */
  drawOrder(): string[] {
    const visible: Rect = visibleWorldRect(this.camera, this.viewW, this.viewH)
    return [...this.grids.values()]
      .filter((g) =>
        rectsIntersect(visible, {
          x: g.originX,
          y: g.originY,
          w: g.cols * g.cellW,
          h: g.rows * g.cellH
        })
      )
      .sort((a, b) => a.z - b.z || a.seq - b.seq)
      .map((g) => g.id)
  }

  /** True while the atlas holds pixels the GPU has not seen. `!atlasUploaded` is NOT covered
   *  by `atlas.dirty`: an atlas populated before the engine existed (or by another consumer
   *  that already called clearDirty) reports clean while the texture is still empty — that
   *  atlas must reach the GPU on the first frame, and the pending upload is itself damage, or
   *  a canvas that goes idle right after would sit on solid blocks until the next input. */
  private atlasUploadPending(): boolean {
    return !!this.atlas.source && (this.atlas.dirty || !this.atlasUploaded)
  }

  /** Draw ONE frame if anything is dirty; returns whether it drew. */
  frame(): boolean {
    const uploadAtlas = this.atlasUploadPending()
    if (!this.dirty && !uploadAtlas) return false
    this.dirty = false
    if (uploadAtlas && this.atlas.source) {
      // BEFORE any drawGrid, always: see the class contract.
      this.gl.uploadAtlas(this.atlas.source, this.atlas.sizePx, this.atlas.cellW, this.atlas.cellH)
      this.atlas.clearDirty()
      this.atlasUploaded = true
    }
    this.gl.beginFrame(this.camera)
    for (const id of this.drawOrder()) {
      const g = this.grids.get(id)
      if (!g) continue
      this.gl.drawGrid({
        cells: g.cells,
        cols: g.cols,
        rows: g.rows,
        cellW: g.cellW,
        cellH: g.cellH,
        originX: g.originX,
        originY: g.originY,
        bgColor: g.bgColor
      })
    }
    this.gl.endFrame()
    return true
  }
}
