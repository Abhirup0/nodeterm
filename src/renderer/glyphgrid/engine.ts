import type { GlyphAtlas } from './atlas'
import { rectsIntersect, visibleWorldRect, type Camera, type Rect } from './camera'
import { CELL_STRIDE } from './cells'
import type { GridCursor } from './cursor'
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
  /**
   * The plate's corner radius in world units — the node's own `border-radius`, so the opaque
   * ground under a rounded node stops reading square (see `GridDrawParams.plateRadius`, which
   * states which corners it shapes and why).
   *
   * OPTIONAL, defaulting to 0 = square, for two reasons that point the same way: 0 reproduces the
   * plate's pre-Phase-2 shape exactly, and a surface with no rounded chrome of its own (the dev
   * harness) should not have to name a radius to say so.
   *
   * REGISTRATION-TIME ONLY — there is deliberately no `setPlateRadius` on the handle. The radius
   * comes from a stylesheet constant, not from layout: unlike the plate RECT (which a
   * ResizeObserver re-pushes on every tick) nothing moves it while a node lives, and the paths
   * that could change it — a font/theme generation bump — already tear the grid down and register
   * a fresh one. Add a setter when something can actually change it, not before.
   */
  plateRadius?: number
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
  /**
   * The cursor drawn OVER this grid's cells, or null for none.
   *
   * Only non-block shapes belong here: a block cursor is expressed in the CELL data (the feed swaps
   * that cell's colours so the glyph inverts), and an overlay quad would paint over the inversion it
   * just produced. The owner decides which — see `cursor.ts`.
   *
   * Change-gated on every field, and its damage is VISIBILITY-SCOPED like `updateRow`'s: the cursor
   * moves on every keystroke, so an off-screen terminal being typed into must not wake the shared
   * canvas. Safe for a simpler reason than the row ranges — the cursor is a VALUE, replayed from the
   * grid on whatever frame draws it next, so nothing can be lost by deferring it.
   */
  setCursor(cursor: GridCursor | null): void
  setZ(z: number): void
  resize(cols: number, rows: number): void
  /** Drops the grid. After this the handle is INERT — every mutator above becomes a silent
   *  no-op rather than a throw: a torn-down owner delivering one last write is a teardown
   *  race, not a bug, and it must neither mutate a dead grid nor un-idle the shared canvas.
   *  `GlyphGridEngine.disposeAll()` puts every outstanding handle into the same state. */
  dispose(): void
}

/** Are two cursor specs the same paint? Null-tolerant, field-by-field — the handle re-derives its
 *  spec from live buffer state, so equality is what keeps a re-derivation from dirtying the
 *  engine. */
function sameCursor(a: GridCursor | null, b: GridCursor | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.col === b.col &&
    a.row === b.row &&
    a.shape === b.shape &&
    a.widthCells === b.widthCells &&
    a.color === b.color
  )
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
  /** The overlay cursor drawn after this grid's cells, or null. Not part of `GridSpec`: a grid is
   *  registered before its terminal has ever packed a row, so "no cursor yet" is the only honest
   *  starting state and every owner would otherwise have to spell it out. */
  cursor: GridCursor | null
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
 *
 * An atlas RESET needs no special handling here, which is worth stating because it looks like it
 * should: it happens during a row PACK, never inside `frame()` (nothing this class calls allocates
 * a glyph), and it marks the atlas dirty — so the very next frame re-uploads the cleared and
 * refilled page before it uploads or draws a single row of it. Rows still naming old slots are the
 * addon's problem, and it repacks them from the redraw it requests (see
 * `GlyphGridRendererAddonCore.handleAtlasReset`).
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
  /** Wake subscribers, notified by `markDirty` on the clean→dirty EDGE only — see `onDamage`. */
  private damageListeners = new Set<() => void>()
  private seq = 0
  /** False until an atlas source has actually reached the GPU — see `atlasUploadPending`. */
  private atlasUploaded = false
  /** True between `suspendGpu` and `reviveGpu` — i.e. while the GL context has been lost and the
   *  GPU objects do not exist. The frame gate reads it; nothing else does. */
  private gpuSuspended = false

  constructor(
    private gl: GlyphGL,
    private atlas: GlyphAtlas
  ) {}

  /**
   * The ONE writer of the `dirty` flag. Every mutator routes its damage through here, so the wake
   * signal below cannot drift out of sync with the flag `frame()` gates on — a direct
   * `dirty = true` somewhere would be damage the parked driver never hears about, and a canvas
   * that stops repainting until the user drags something.
   *
   * Notifies on the clean→dirty TRANSITION only: a terminal streaming output dirties the engine on
   * every row write, and calling out sixty times per frame would make the wake more expensive than
   * the loop it saves. Once dirty, the driver is already coming.
   */
  private markDirty(): void {
    if (this.dirty) return
    this.dirty = true
    for (const fn of this.damageListeners) fn()
  }

  /**
   * Subscribe to damage — the signal the rAF driver parks against (see `createFrameLoop`). Fires
   * when the engine goes from clean to dirty, i.e. exactly when an idle canvas has something new
   * to draw.
   *
   * Deliberately says nothing about a HIDDEN grid's row writes: those do not dirty the engine (see
   * `updateRow`), so they do not wake the loop either. Their damage rides the frame that brings
   * the grid back into view, and every input that can change visibility dirties unconditionally.
   *
   * A listener must not call `frame()` inline — it runs inside the mutator that caused the damage,
   * and the driver's contract is to SCHEDULE.
   */
  onDamage(cb: () => void): { dispose(): void } {
    this.damageListeners.add(cb)
    return {
      dispose: () => {
        this.damageListeners.delete(cb)
      }
    }
  }

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
      cursor: null,
      dead: false
    }
    this.grids.set(spec.id, grid)
    this.gl.createGrid(spec.id, spec.cols, spec.rows)
    this.markDirty()
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
        if (grid.lastVisible) engine.markDirty()
      },
      setOrigin(x, y) {
        if (grid.dead) return
        if (grid.originX === x && grid.originY === y) return
        grid.originX = x
        grid.originY = y
        engine.markDirty()
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
        engine.markDirty()
      },
      setCursor(cursor) {
        if (grid.dead) return
        if (sameCursor(grid.cursor, cursor)) return
        // COPIED, not aliased: the owner re-derives one spec object per pack and would otherwise be
        // free to mutate the value the next frame draws from — and the change gate above would
        // never see the difference, so the canvas would keep drawing a cursor that has moved.
        grid.cursor = cursor ? { ...cursor } : null
        // Visibility-scoped, the ONLY mutator besides updateRow that is — see the interface comment
        // and the long argument in updateRow. The frame that brings a hidden grid back into view is
        // always drawn (every visibility input dirties unconditionally) and reads `grid.cursor` as
        // it stands then, so nothing is lost by not waking the canvas for an off-screen keystroke.
        if (grid.lastVisible) engine.markDirty()
      },
      setZ(z) {
        if (grid.dead) return
        if (grid.z === z) return
        grid.z = z
        engine.markDirty()
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
        engine.markDirty()
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
        engine.markDirty()
      }
    }
  }

  /**
   * Drop every grid at once: free each GPU buffer, empty the registry, and leave every handle
   * ever handed out INERT — exactly as if its owner had called `dispose()` itself.
   *
   * This is the layer's TEARDOWN path — the context being handed back for good (the mode switched
   * off, a font or dpr rebuild, a permanent failure). **It is NOT the context-loss path**, which is
   * `suspendGpu` below: that one drops the same GPU objects while KEEPING the registry, and the two
   * must not be confused. Running THIS on a lost context leaves every terminal on the canvas
   * holding a dead handle with nothing to re-register into — which is exactly the Phase-1b
   * behaviour (limitation L9) that the suspend/revive cycle exists to remove.
   *
   * Every owner (a terminal node) is still holding a live handle when this runs, and without a
   * sweep those handles would keep writing rows into a registry whose GPU objects no longer exist.
   * Reaching them is what `Grid.dead` is for — see its comment: the engine deliberately keeps no
   * list of handles, so the shared Grid object is the channel.
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
    this.markDirty()
  }

  /**
   * Drop every GPU object but KEEP the registry: each grid's spec, its CPU-side cells and its z
   * survive, so the same handles are valid after `reviveGpu` and no owner has to re-register.
   * Nothing else may assume a grid's GPU buffer exists — the frame gate below is what enforces
   * that, since a draw is the only thing that would touch one.
   *
   * This is the `webglcontextlost` half of the restore cycle, and it is the OPPOSITE of
   * `disposeAll`: that one ends the grids (every handle goes inert, the registry empties), this one
   * ends only the buffers. A lost context that ran `disposeAll` would leave every terminal on the
   * canvas holding a dead handle, which is the Phase-1b behaviour this task exists to remove.
   *
   * **It deliberately does NOT `markDirty`.** Damage is the WAKE signal (see `markDirty`), and
   * waking here would schedule a frame against the context that has just gone away. The revive
   * dirties instead, which is the moment there is something to draw with again.
   */
  /**
   * Are the GPU objects currently gone (between a `suspendGpu` and its `reviveGpu`)?
   *
   * Exists for ONE caller: the layer's mount path. The engine is a module singleton while the
   * restore policy that drives this cycle is scoped to a React effect, so a mount that lands on a
   * suspended engine is a mount whose policy is not waiting for anything — and nothing else can
   * detect that. See the guard in `SharedGlyphLayer`'s effect.
   */
  gpuIsSuspended(): boolean {
    return this.gpuSuspended
  }

  suspendGpu(): void {
    if (this.gpuSuspended) return
    this.gpuSuspended = true
    // The buffers are already gone from the driver's side on a real loss, so these are no-ops
    // there; they are what keeps the GL layer's own grid table honest, and they free properly if
    // this is ever called against a live context.
    for (const g of this.grids.values()) this.gl.disposeGrid(g.id)
  }

  /**
   * Re-create the GPU objects for every registered grid and mark everything dirty — the
   * `webglcontextrestored` half.
   *
   * ORDER: the GL layer rebuilds ITS objects first (programs, atlas texture — `restore`), because
   * the per-grid buffers created below are allocated against them. If that throws, nothing here has
   * changed and the engine stays suspended: the caller's answer is a permanent fallback, and this
   * must never retry a rebuild on its own.
   *
   * NO REPACK IS NEEDED, which is the point of keeping the registry. The CPU side survived a GPU
   * event untouched: each grid's `cells` still holds every lane the terminal ever wrote, and the
   * atlas page still holds the rasterized glyphs those lanes name. So marking every row dirty and
   * re-uploading the atlas reproduces the exact screen that was on the canvas, without asking a
   * single addon for anything.
   *
   * A revive with no suspend is a NO-OP: `webglcontextrestored` can arrive for a context we never
   * suspended (a browser restoring one we have already given up on), and rebuilding there would
   * allocate a second buffer per grid and leak the first.
   */
  reviveGpu(): void {
    if (!this.gpuSuspended) return
    this.gl.restore()
    for (const g of this.grids.values()) {
      this.gl.createGrid(g.id, g.cols, g.rows)
      // A fresh buffer is ZEROED, so every grid owes the GPU all of its rows — exactly the state
      // `register` starts a brand-new grid in.
      g.dirtyFrom = 0
      g.dirtyTo = g.rows - 1
      // Conservative, for the same reason `register` starts it true: no draw order has been
      // computed against the new context yet, and guessing "hidden" would drop the damage of a
      // grid nobody has culled.
      g.lastVisible = true
    }
    // The texture died with the context. The atlas SOURCE (an OffscreenCanvas) did not, so this is
    // one upload, not a re-rasterization.
    this.atlasUploaded = false
    // Cleared BEFORE the dirty: `markDirty` notifies the wake subscribers, and they must find an
    // engine that can actually draw the frame they are about to schedule.
    this.gpuSuspended = false
    this.markDirty()
  }

  setCamera(cam: Camera): void {
    if (cam.x === this.camera.x && cam.y === this.camera.y && cam.zoom === this.camera.zoom) return
    this.camera = { ...cam }
    this.markDirty()
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
    this.markDirty()
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
    // THE FRAME GATE OF THE RESTORE CYCLE. Between a `suspendGpu` and its `reviveGpu` there are no
    // GPU objects, so a submission would throw against deleted buffers — and the driver's catch
    // reads a throw as a GPU failure and burns the session that is in the middle of recovering.
    // The layer parks its loop on the loss as well; this is the floor under that, for the frame
    // already scheduled when the context went away. Damage accumulated meanwhile is not lost — the
    // dirty flag and the per-grid ranges are untouched, and the revive re-dirties everything.
    if (this.gpuSuspended) return false
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
          plateH: g.plateH,
          // `?? 0` here rather than at registration, so an omitted radius reads as "square" at
          // the one place that has to answer the GL layer — and `GridSpec.plateRadius` stays
          // honestly optional instead of being silently rewritten on the grid.
          plateRadius: g.plateRadius ?? 0,
          cursor: g.cursor
        })
      }
      this.gl.endFrame()
    } catch (err) {
      this.markDirty()
      throw err
    }
    return true
  }
}
