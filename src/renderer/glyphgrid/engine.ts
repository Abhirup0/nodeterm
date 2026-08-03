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
  /** Padding around the grid rect, in world units, that the opaque plate also covers — the node
   *  body's inset. See gl.ts's GridDrawParams. */
  padPx: number
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
  /** Drops the grid. After this the handle is INERT — every mutator above becomes a silent
   *  no-op rather than a throw: a torn-down owner delivering one last write is a teardown
   *  race, not a bug, and it must neither mutate a dead grid nor un-idle the shared canvas. */
  dispose(): void
}

interface Grid extends GridSpec {
  /** Row-major: the cell at (row, col) starts at lane `(row * cols + col) * CELL_STRIDE`.
   *  This is the layout the instanced shader binds — see gl.ts / gl-webgl2.ts.
   *
   *  Kept CPU-side even though the GPU now owns a copy: it is the culling-independent source a
   *  HIDDEN grid's deferred upload replays from, and the only place a partial row write can be
   *  merged before it becomes a range. */
  cells: Uint32Array
  seq: number // registration order — the z tie-break
  /** Inclusive contiguous damage range; `-1/-1` = clean.
   *
   *  CONTIGUOUS BY POLICY: two touched rows widen ONE span that swallows the untouched rows
   *  between them. A terminal's damage is overwhelmingly a single run (a scrolled region, an
   *  edited line), and one slightly-too-wide bufferSubData is cheaper than N calls plus the
   *  bookkeeping to track disjoint runs. */
  dirtyFrom: number
  dirtyTo: number
}

/**
 * The renderer's brain: a registry of grids, damage tracking, culling and z-ordered submission.
 *
 * Two contracts the rest of the engine depends on:
 * - **Idle frames cost nothing.** `frame()` draws only when something actually changed and
 *   reports whether it drew, so the rAF driver (and the tests) can prove an untouched canvas
 *   issues zero GL calls.
 * - **The atlas is uploaded before `beginFrame`** — not merely before the first `drawGrid`.
 *   `beginFrame` pushes the uAtlasCols/uAtlasCell uniforms from the values `uploadAtlas`
 *   stored, so an upload squeezed between `beginFrame` and `drawGrid` would leave frame 1
 *   sampling slot 0 everywhere and the uniforms permanently one upload stale. A draw that
 *   samples a texture the glyphs have not been uploaded into paints solid blocks; the engine
 *   is the only place that sees both, so it is the enforcer.
 */
export class GlyphGridEngine {
  private grids = new Map<string, Grid>()
  private camera: Camera = { x: 0, y: 0, zoom: 1 }
  private viewW = 1
  private viewH = 1
  /** Stored so setViewport can change-gate on all THREE inputs. 0 = never sized, so the first
   *  setViewport always reaches the GL surface even if it passes the current w/h. */
  private viewDpr = 0
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
      seq: this.seq++,
      // A brand-new grid owes the GPU every row: createGrid only ZEROES the buffer, and the
      // owner's first writes may land before the first frame.
      dirtyFrom: 0,
      dirtyTo: spec.rows - 1
    }
    this.grids.set(spec.id, grid)
    this.gl.createGrid(spec.id, spec.cols, spec.rows)
    this.dirty = true
    const engine = this
    // Per-handle, not per-grid: once THIS handle is disposed every mutator below is a silent
    // no-op. The constraint is that a stale handle must not un-idle the shared canvas — a
    // Phase-1b terminal is torn down while its last row write may still be in flight, and a
    // write that dirtied the engine after dispose would keep one canvas redrawing forever for
    // a grid nobody draws. Inert rather than throwing: the race is expected at teardown.
    let disposed = false
    return {
      updateRow(row, cells) {
        if (disposed) return
        if (row < 0 || row >= grid.rows)
          throw new Error(`glyphgrid: row ${row} out of range (rows=${grid.rows})`)
        if (cells.length !== grid.cols * CELL_STRIDE)
          throw new Error(`glyphgrid: row length ${cells.length} != ${grid.cols * CELL_STRIDE}`)
        grid.cells.set(cells, row * grid.cols * CELL_STRIDE)
        // Widen the contiguous range. `dirtyTo` is -1 when clean, so Math.max picks up `row`
        // on its own; `dirtyFrom` needs the explicit clean check (-1 would win a Math.min).
        grid.dirtyFrom = grid.dirtyFrom < 0 ? row : Math.min(grid.dirtyFrom, row)
        grid.dirtyTo = Math.max(grid.dirtyTo, row)
        engine.dirty = true
      },
      setOrigin(x, y) {
        if (disposed) return
        if (grid.originX === x && grid.originY === y) return
        grid.originX = x
        grid.originY = y
        engine.dirty = true
      },
      setZ(z) {
        if (disposed) return
        if (grid.z === z) return
        grid.z = z
        engine.dirty = true
      },
      resize(cols, rows) {
        if (disposed) return
        // A same-shape resize is a no-op, not a realloc: resize callers are size observers
        // that fire on every layout tick, and reallocating + dirtying there would keep the
        // canvas redrawing forever.
        if (grid.cols === cols && grid.rows === rows) return
        // Content is re-fed by the owner after a real shape change; carrying old cells over
        // it would misalign every row.
        grid.cols = cols
        grid.rows = rows
        grid.cells = new Uint32Array(cols * rows * CELL_STRIDE)
        // The GPU buffer is sized in cells, so a reshape must REALLOCATE it — bufferSubData
        // against the old size would either overrun or leave a tail of the previous shape.
        engine.gl.createGrid(grid.id, cols, rows)
        grid.dirtyFrom = 0
        grid.dirtyTo = rows - 1
        engine.dirty = true
      },
      dispose() {
        // The handle goes inert unconditionally — this is its owner declaring teardown, and it
        // holds whether or not the map still points at this grid.
        disposed = true
        // Identity-checked: only drop the map entry if it is still THIS grid, so a stale
        // handle can never evict a grid that re-registered under the same id — nor free the GPU
        // buffer that grid is now drawing from.
        if (engine.grids.get(grid.id) !== grid) return
        engine.grids.delete(grid.id)
        engine.gl.disposeGrid(grid.id)
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
    // Change-gated like setCamera, and on the dpr too: the caller is a resize observer that
    // fires on every layout tick, so an unconditional dirty here would keep the canvas
    // redrawing forever. A dpr-only change is a real change — same CSS box, different backing
    // store — so it must still resize and dirty.
    if (w === this.viewW && h === this.viewH && dpr === this.viewDpr) return
    this.viewW = w
    this.viewH = h
    this.viewDpr = dpr
    this.gl.resize(w, h, dpr)
    this.dirty = true
  }

  /** Visible grid ids in draw order (z ascending, ties by registration order). Pure.
   *
   *  Culled against the PADDED rect, not the character matrix: a grid draws its opaque plate
   *  (the node body, `padPx` world units wider on every side) before its cells, so a grid whose
   *  cells have just left the viewport may still owe it a visible strip of body. Culling on the
   *  cell rect alone would pop that strip away at every viewport edge — and, worse, would skip
   *  the plate that occludes whatever sits underneath it. */
  drawOrder(): string[] {
    const visible: Rect = visibleWorldRect(this.camera, this.viewW, this.viewH)
    return [...this.grids.values()]
      .filter((g) =>
        rectsIntersect(visible, {
          x: g.originX - g.padPx,
          y: g.originY - g.padPx,
          w: g.cols * g.cellW + 2 * g.padPx,
          h: g.rows * g.cellH + 2 * g.padPx
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

  /**
   * Draw ONE frame if anything is dirty; returns whether it drew.
   *
   * The engine-wide `dirty` flag is the frame GATE (does anything need drawing at all); the
   * per-grid ranges decide UPLOAD granularity (how much of each grid reaches the GPU).
   *
   * **Damage-restore policy on a throw.** Two kinds of damage are in play and both must survive
   * a GL call that throws mid-frame (context lost, driver error):
   * - the frame-wide `dirty` flag, cleared up front and restored by the catch below;
   * - each grid's row range, which is cleared ONLY AFTER its `uploadRows` has RETURNED. That
   *   ordering is the whole policy: a grid whose upload threw still owes those rows, and a grid
   *   whose upload succeeded before the throw does not (its GPU buffer is current, and the
   *   redraw the restored `dirty` flag schedules will draw from it). Clearing ranges up front —
   *   or in one sweep after the loop — would either lose rows that never reached the GPU or
   *   re-upload rows that did.
   */
  frame(): boolean {
    const uploadAtlas = this.atlasUploadPending()
    if (!this.dirty && !uploadAtlas) return false
    this.dirty = false
    // Damage must survive a throwing submission: the dirty flag was already cleared, so a GL
    // call that throws mid-frame (context lost, a driver error) would otherwise leave the
    // engine idle on a half-drawn canvas until the next unrelated input. Restore the damage and
    // RETHROW — the caller owns the error policy, and swallowing here would hide GPU errors.
    try {
      if (uploadAtlas && this.atlas.source) {
        // BEFORE beginFrame, always (it reads back the atlas metrics as uniforms): see the
        // class contract.
        this.gl.uploadAtlas(
          this.atlas.source,
          this.atlas.sizePx,
          this.atlas.cellW,
          this.atlas.cellH
        )
        this.atlas.clearDirty()
        this.atlasUploaded = true
      }
      // Computed ONCE and reused by both passes: it allocates, filters and sorts, and the two
      // passes must agree on exactly which grids are visible this frame.
      const order = this.drawOrder()
      // Upload pass. Only VISIBLE grids upload: a hidden grid's range persists un-uploaded until
      // it scrolls back into view, which is what keeps a canvas of fifty terminals from paying
      // for the forty-five nobody can see. Their CPU-side cells stay authoritative, so the
      // deferred upload replays everything owed in one call, not one per skipped frame.
      for (const id of order) {
        const g = this.grids.get(id)
        if (!g || g.dirtyFrom < 0 || g.dirtyTo < g.dirtyFrom) continue
        const rowLanes = g.cols * CELL_STRIDE
        this.gl.uploadRows(
          g.id,
          g.dirtyFrom,
          g.dirtyTo - g.dirtyFrom + 1,
          g.cols,
          // A VIEW, not a copy — the GL layer hands it straight to bufferSubData.
          g.cells.subarray(g.dirtyFrom * rowLanes, (g.dirtyTo + 1) * rowLanes)
        )
        // Cleared only now that the upload has returned — see the damage-restore policy above.
        g.dirtyFrom = -1
        g.dirtyTo = -1
      }
      this.gl.beginFrame(this.camera)
      for (const id of order) {
        const g = this.grids.get(id)
        if (!g) continue
        this.gl.drawGrid({
          id: g.id,
          cols: g.cols,
          rows: g.rows,
          cellW: g.cellW,
          cellH: g.cellH,
          originX: g.originX,
          originY: g.originY,
          bgColor: g.bgColor,
          padPx: g.padPx
        })
      }
      this.gl.endFrame()
    } catch (err) {
      this.dirty = true
      throw err
    }
    return true
  }
}
