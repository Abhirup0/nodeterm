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
  /** The opaque plate's own world rect — the node BODY, which is generally larger than the
   *  character matrix. Independent of the grid geometry on purpose; see gl.ts's
   *  `GridDrawParams.plateX`. */
  plateX: number
  plateY: number
  plateW: number
  plateH: number
}

export interface GridHandle {
  /**
   * Replace one row of cells. `cells` is exactly `cols * CELL_STRIDE` lanes laid out per
   * cells.ts ([glyph, fg, bg, flags] per cell) and is COPIED, so the caller may reuse its
   * scratch buffer.
   *
   * Always marks THIS grid's rows dirty; marks the ENGINE dirty (i.e. schedules a frame) only
   * while the grid was visible in the last computed draw order — a hidden grid's damage is
   * deferred, not lost, and rides the frame that brings it back into view. Callers therefore
   * cannot read a `frame()` of `false` as "my write was dropped".
   *
   * The glyph lane must be a slot obtained from `GlyphAtlas.glyphFor(code, bold, italic, fg, bg)` —
   * never a raw code point. The atlas owns the slot space (0 is the permanently blank slot,
   * and an unrasterized code degrades to it), so a code point written here would sample an
   * arbitrary neighbouring glyph.
   */
  updateRow(row: number, cells: Uint32Array): void
  setOrigin(x: number, y: number): void
  /**
   * Move/resize the opaque plate — the node BODY rect in world units. Separate from `setOrigin`
   * because the two move for different reasons and at different times: the grid follows the
   * terminal SCREEN inside the node, the plate follows the body box. A resize changes the body
   * on every layout tick while the screen offset may not move at all, so the owner (a
   * ResizeObserver) calls both and each change-gates itself.
   */
  setPlateRect(x: number, y: number, w: number, h: number): void
  setZ(z: number): void
  resize(cols: number, rows: number): void
  /** Drops the grid. After this the handle is INERT — every mutator above becomes a silent
   *  no-op rather than a throw: a torn-down owner delivering one last write is a teardown
   *  race, not a bug, and it must neither mutate a dead grid nor un-idle the shared canvas.
   *  `GlyphGridEngine.disposeAll()` puts every outstanding handle into the same state. */
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
  /** Was this grid in the LAST computed draw order? Refreshed by every `drawOrder()` call and
   *  read only by `updateRow`, to keep a hidden grid's row writes from waking the shared canvas.
   *
   *  Starts TRUE — conservative. A grid that has never been in any draw order (registered, no
   *  frame yet) must be treated as visible: guessing "hidden" would drop the damage of a grid
   *  nobody has culled yet. It costs nothing, because `register` dirties the engine anyway.
   *
   *  Lives on the GRID rather than in a per-frame set so `updateRow` — the hot path, called per
   *  terminal row — reads it off the object it already holds. */
  lastVisible: boolean
  /** Set by this grid's `dispose()` AND by `disposeAll()`. It is the ONE inertness flag every
   *  handle reads: a handle closes over its Grid, so marking the grid reaches the handle without
   *  the engine having to keep a list of live handles (which would be a leak of its own — a
   *  strong ref to every terminal that ever registered). One handle exists per Grid object
   *  (register mints exactly one and refuses a duplicate id), so per-grid and per-handle mean the
   *  same thing here; a re-registration under the same id builds a NEW Grid, leaving the old one
   *  — and its stale handle — dead. */
  dead: boolean
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
      dirtyTo: spec.rows - 1,
      lastVisible: true,
      dead: false
    }
    this.grids.set(spec.id, grid)
    this.gl.createGrid(spec.id, spec.cols, spec.rows)
    this.dirty = true
    const engine = this
    // Inertness rides on `grid.dead`: once this handle's dispose() — or the engine-wide
    // disposeAll() — has run, every mutator below is a silent no-op. The constraint is that a
    // stale handle must not un-idle the shared canvas — a Phase-1b terminal is torn down while
    // its last row write may still be in flight, and a write that dirtied the engine after
    // dispose would keep one canvas redrawing forever for a grid nobody draws. Inert rather than
    // throwing: the race is expected at teardown.
    return {
      updateRow(row, cells) {
        if (grid.dead) return
        if (row < 0 || row >= grid.rows)
          throw new Error(`glyphgrid: row ${row} out of range (rows=${grid.rows})`)
        if (cells.length !== grid.cols * CELL_STRIDE)
          throw new Error(`glyphgrid: row length ${cells.length} != ${grid.cols * CELL_STRIDE}`)
        grid.cells.set(cells, row * grid.cols * CELL_STRIDE)
        // Widen the contiguous range. `dirtyTo` is -1 when clean, so Math.max picks up `row`
        // on its own; `dirtyFrom` needs the explicit clean check (-1 would win a Math.min).
        grid.dirtyFrom = grid.dirtyFrom < 0 ? row : Math.min(grid.dirtyFrom, row)
        grid.dirtyTo = Math.max(grid.dirtyTo, row)
        // VISIBILITY-SCOPED, and the only mutator that is: a hidden grid's row write owes the GPU
        // nothing THIS frame (the upload pass skips culled grids anyway), so waking the shared
        // canvas for it buys a redraw in which nothing of this grid appears. Under the Phase-1b
        // load — fifty terminals, forty-five of them off-screen and streaming — that is the whole
        // canvas redrawing at the speed of the busiest invisible node.
        //
        // Safe because visibility can only change through `setCamera`/`setViewport`/`register`/
        // `resize`/`setOrigin`/`setPlateRect`/`setZ`, and every one of those dirties
        // UNCONDITIONALLY. (`setPlateRect` belongs on that list: culling is the union of the plate
        // rect and the cell rect — see `drawOrder` — so the plate is a visibility INPUT, and a
        // grid can become visible by its plate moving alone.) So the frame that brings a grid into
        // view is always drawn, and its upload pass replays the range accumulated while it was
        // hidden — deferred, never lost. Do not "optimize" any of those into a visibility-scoped
        // dirty; that is the leg this stands on.
        if (grid.lastVisible) engine.dirty = true
      },
      setOrigin(x, y) {
        if (grid.dead) return
        if (grid.originX === x && grid.originY === y) return
        grid.originX = x
        grid.originY = y
        engine.dirty = true
      },
      setPlateRect(x, y, w, h) {
        if (grid.dead) return
        // Change-gated like every other mutator, and for the usual reason: the caller is a
        // ResizeObserver / origin sync that fires on every layout tick, and an unconditional
        // dirty there would keep the shared canvas redrawing forever.
        if (grid.plateX === x && grid.plateY === y && grid.plateW === w && grid.plateH === h)
          return
        grid.plateX = x
        grid.plateY = y
        grid.plateW = w
        grid.plateH = h
        engine.dirty = true
      },
      setZ(z) {
        if (grid.dead) return
        if (grid.z === z) return
        grid.z = z
        engine.dirty = true
      },
      resize(cols, rows) {
        if (grid.dead) return
        // Identity-checked like dispose(), and for the mirror-image reason: this is the one
        // mutator that ALLOCATES GPU memory (createGrid), so running it for a grid the registry
        // no longer points at would leave a buffer nothing can ever dispose — the registry is the
        // only list of what exists. A second, independent gate on purpose: `dead` and the map are
        // set together today, and this one is what still holds if a future teardown path drops
        // one of them. Resize callers are size observers firing on every layout tick, which makes
        // this the mutator most likely to arrive after teardown.
        if (engine.grids.get(grid.id) !== grid) return
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
        grid.dead = true
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

  /**
   * Drop every grid at once: free each GPU buffer, empty the registry, and leave every handle
   * ever handed out INERT — exactly as if its owner had called `dispose()` itself.
   *
   * This is the layer's teardown / context-loss path. On a lost context the grid buffers are
   * already gone from the driver's side, and the owners (terminal nodes) are still holding live
   * handles; without a sweep those handles would keep writing rows into a registry whose GPU
   * objects no longer exist. Reaching them is what `Grid.dead` is for — see its comment: the
   * engine deliberately keeps no list of handles, so the shared Grid object is the channel.
   *
   * Idempotent, and change-gated: sweeping an empty registry changes nothing on screen, so it
   * must not dirty — the same discipline as setCamera/setViewport, and the reason `frame()` can
   * promise that an untouched canvas issues zero GL calls.
   */
  disposeAll(): void {
    if (this.grids.size === 0) return
    for (const g of this.grids.values()) {
      g.dead = true
      this.gl.disposeGrid(g.id)
    }
    this.grids.clear()
    // Teardown is damage: the canvas still holds the disposed grids' pixels until it is redrawn.
    this.dirty = true
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

  /** Visible grid ids in draw order (z ascending, ties by registration order).
   *
   *  Not pure: it also CACHES each grid's visibility on the grid (`lastVisible`), which is what
   *  `updateRow` consults to keep a hidden grid's writes from waking the shared canvas. The cache
   *  is a pure function of the camera, the viewport and the grid rects — so recomputing it out of
   *  band (a stats read-out, a test) can only write the same answer the next frame would, and
   *  every input that could change it dirties the engine.
   *
   *  Culled against the UNION of the plate rect and the cell rect, never one alone. A grid draws
   *  its opaque plate — the node BODY, an independent rect that is normally larger than the
   *  character matrix but is NOT guaranteed to contain it — before its cells, and either part can
   *  be the only one on screen:
   *   - cells offscreen, plate visible: a grid scrolled just past the edge still owes a strip of
   *     body, and skipping it would also skip the plate that occludes whatever sits underneath;
   *   - plate offscreen, cells visible: nothing structurally forbids a grid drawn outside its own
   *     body (a stale plate rect mid-resize), and culling it would blank a terminal that is in
   *     plain view.
   *  Two intersection tests, not one bounding-box union: the bounding box of two disjoint rects
   *  covers ground neither of them does, so it would keep grids alive that draw no pixel. */
  drawOrder(): string[] {
    const visible: Rect = visibleWorldRect(this.camera, this.viewW, this.viewH)
    return [...this.grids.values()]
      .filter((g) => {
        // Written for EVERY grid, not just the survivors — a grid that has just left the
        // viewport has to learn it is hidden, and only the filter's own answer can tell it.
        g.lastVisible =
          rectsIntersect(visible, { x: g.plateX, y: g.plateY, w: g.plateW, h: g.plateH }) ||
          rectsIntersect(visible, {
            x: g.originX,
            y: g.originY,
            w: g.cols * g.cellW,
            h: g.rows * g.cellH
          })
        return g.lastVisible
      })
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
          this.atlas.cellH,
          this.atlas.strideX,
          this.atlas.strideY
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
          plateX: g.plateX,
          plateY: g.plateY,
          plateW: g.plateW,
          plateH: g.plateH
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
