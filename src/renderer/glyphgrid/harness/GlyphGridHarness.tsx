// Dev-only proving ground for the glyphgrid engine: 43 synthetic 80x24 terminals (40 disjoint +
// a 3-grid OVERLAPPING cluster), streaming random lines at ~30Hz, camera drag+wheel-zoom, FPS +
// draw + row-upload counters. THE Phase-0/1a acceptance gate: 60fps pan/zoom, idle frames drawing
// nothing, one WebGL context total, plates occluding in z order, uploads costing only the rows
// that changed.
//
// It opens with all 43 grids framed and reports how many it is actually DRAWING, so the fps
// figure a tester signs off on is always attributable to a known load — the engine culls, and
// both of those were once free to lie in opposite directions. The two Phase-1 mechanisms an
// acceptance run has to actually EXERCISE — occlusion between overlapping grids, and row-granular
// uploads — are the overlap cluster and the `rows-up/s` figure respectively; without them the run
// would sign off claims it never put under load.
//
// Reached only through the dev route in src/renderer/main.tsx
// (`import.meta.env.DEV && location.hash === '#glyphgrid'`), so this module is dead code in a
// production build — see the report for the verified chunk split.
import { useEffect, useRef, useState } from 'react'
import { GlyphAtlas } from '../atlas'
import { packColor, writeCell, CELL_STRIDE, FLAG_BOLD } from '../cells'
import { GlyphGridEngine, type GridHandle } from '../engine'
import type { GlyphGL } from '../gl'
import { createWebgl2GL } from '../gl-webgl2'
import { createCanvasRasterizer } from '../raster'

const COLS = 80
const ROWS = 24
const GRIDS = 40
/** A deliberately OVERLAPPING cluster registered on top of the 40 disjoint grids. The disjoint
 *  layout never puts one plate over another, so the painter's-order occlusion path — the whole
 *  point of the per-grid opaque plate — is untested by eye in a run that only draws it. Three
 *  grids at distinct z, each tinted differently, make "the higher z covers the lower one" a
 *  visible fact the tester can sign off on. */
const OVERLAP_GRIDS = 3
/** Everything registered with the engine — the meter's denominator. */
const TOTAL_GRIDS = GRIDS + OVERLAP_GRIDS
const CELL_W = 9
const CELL_H = 18
const ATLAS_PX = 1024
/** World-unit padding the occlusion plate adds around each grid — a stand-in for the terminal
 *  node body's inset. Well under the 40/60 layout pitch, so plates stay separated. */
const PAD_PX = 8

// --- Layout. Derived, not duplicated: register() below places grids from these same constants,
// so the initial camera and the meter can never drift from where the grids actually are. ---
const PER_ROW = 8
const PITCH_X = COLS * CELL_W + 40
const PITCH_Y = ROWS * CELL_H + 60
const LAYOUT_ROWS = Math.ceil(GRIDS / PER_ROW)
/** World-space bounding box of every registered grid — 6040 x 2400 at the constants above. */
const WORLD_W = (Math.min(GRIDS, PER_ROW) - 1) * PITCH_X + COLS * CELL_W
const WORLD_H = (LAYOUT_ROWS - 1) * PITCH_Y + ROWS * CELL_H
/** Overlap-cluster placement: a base inside the FIRST layout row, then each member staggered by
 *  half a grid on both axes. Its extents (2960 x 864 at the constants above) sit strictly inside
 *  the WORLD_W x WORLD_H box the 40 disjoint grids already define, so the cluster changes the
 *  world extents NOT AT ALL — fitCamera below keeps framing exactly what it framed in Phase 0,
 *  and the opening view still shows every registered grid. */
const OVERLAP_X0 = 2 * PITCH_X
const OVERLAP_Y0 = 0
const OVERLAP_STEP_X = (COLS * CELL_W) / 2
const OVERLAP_STEP_Y = (ROWS * CELL_H) / 2
/** One tint per cluster member: the plate AND the cells of that grid are drawn in it, so the
 *  overlap reads as three distinguishable sheets rather than one uniform dark rectangle. */
const OVERLAP_BG = [
  packColor(72, 22, 28, 255),
  packColor(22, 62, 30, 255),
  packColor(26, 30, 92, 255)
]
/** Default grid tint — the 40 disjoint grids' plate and cell background. */
const BASE_BG = packColor(20, 20, 24, 255)
/** A little air around the fitted layout, so the outermost grids are visibly INSIDE the frame
 *  rather than clipping its edge — the tester has to be able to count them. */
const FIT_MARGIN = 0.92
const ZOOM_MIN = 0.05
const ZOOM_MAX = 4

/**
 * The camera the harness OPENS on: the whole layout framed in a `w x h` window.
 *
 * This is load-bearing for the acceptance gate, not a nicety. The engine culls per frame, so the
 * fps the meter reports only describes the grids currently on screen. Opening at
 * `{x:40, y:40, zoom:1}` put roughly four of the forty grids in a typical window — a tester
 * following "the meter shows ~60 fps" would have signed off Phase 0 on a tenth of the advertised
 * load. Starting fitted means the run BEGINS under all 40 and the tester zooms IN from there.
 */
function fitCamera(w: number, h: number): { x: number; y: number; zoom: number } {
  const zoom = Math.min(
    ZOOM_MAX,
    Math.max(ZOOM_MIN, Math.min(w / WORLD_W, h / WORLD_H) * FIT_MARGIN)
  )
  // screen = world * zoom + pan (see the vertex shader) and the layout's top-left IS the world
  // origin, so centering is just the leftover margin, halved.
  return { x: (w - WORLD_W * zoom) / 2, y: (h - WORLD_H * zoom) / 2, zoom }
}

export function GlyphGridHarness() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [stats, setStats] = useState('booting')

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Rasterizer FIRST: it needs no GPU, so a missing OffscreenCanvas bails out before a WebGL
    // context has been created — the brief's order acquired a context it then dropped on the
    // floor unreferenced (the one thing this harness exists to count).
    const raster = createCanvasRasterizer(
      { family: 'monospace', sizePx: 14, cellW: CELL_W, cellH: CELL_H },
      ATLAS_PX
    )
    if (!raster) {
      setStats('OffscreenCanvas unavailable')
      return
    }
    const rawGl = createWebgl2GL(canvas)
    if (!rawGl) {
      setStats('WebGL2 unavailable')
      return
    }
    // Upload instrumentation, and the reason it lives HERE rather than in the engine: Phase 1's
    // central claim is that a cell change costs exactly the ROWS that changed (per-grid GPU
    // buffers + bufferSubData row ranges), replacing Phase 0's re-send of every visible grid's
    // whole cell array. Nothing on screen shows that — fps is identical either way until the load
    // is large enough to melt — so an acceptance instrument that cannot report upload GRANULARITY
    // cannot actually witness the claim it is signing off. engine.ts is deliberately left
    // untouched (a counter there would be production code serving a dev harness); instead the
    // harness decorates the GlyphGL it hands the engine and tallies rows passing through
    // uploadRows. createWebgl2GL returns an object literal, so the spread copies its
    // closure-bound methods and every other call still lands on the real implementation.
    let rowsUploaded = 0
    const gl: GlyphGL = {
      ...rawGl,
      uploadRows(id, firstRow, rowCount, cols, cells) {
        rowsUploaded += rowCount
        rawGl.uploadRows(id, firstRow, rowCount, cols, cells)
      }
    }
    const atlas = new GlyphAtlas(raster, ATLAS_PX)
    // A FRESH engine per effect run: `register` throws on a duplicate id, so reusing an engine
    // across runs (StrictMode double-mount, HMR) would throw on the second pass.
    const engine = new GlyphGridEngine(gl, atlas)
    // Viewport is set on mount and on resize ONLY. setViewport is change-gated on (w, h, dpr)
    // now, but the harness must not lean on that: an unchanged call is cheap, a changed one
    // resets the drawing buffer, so driving it per rAF tick stays the wrong shape.
    const applyViewport = (): void =>
      engine.setViewport(window.innerWidth, window.innerHeight, window.devicePixelRatio)
    applyViewport()

    const handles: GridHandle[] = []
    /** Parallel to `handles`: the tint the feed paints that grid's cells in, so a cluster member
     *  is one solid sheet (plate + cells) instead of a coloured ring around neutral cells. */
    const tints: number[] = []
    for (let i = 0; i < GRIDS; i++) {
      tints.push(BASE_BG)
      handles.push(
        engine.register({
          id: `t${i}`,
          cols: COLS,
          rows: ROWS,
          cellW: CELL_W,
          cellH: CELL_H,
          originX: (i % PER_ROW) * PITCH_X,
          originY: Math.floor(i / PER_ROW) * PITCH_Y,
          z: i,
          bgColor: BASE_BG,
          // Non-zero so the occlusion plate is actually VISIBLE in the harness: it extends the
          // opaque body past the character matrix, the way a terminal node's padding does.
          padPx: PAD_PX
        })
      )
    }
    // The overlap cluster: same size, same feed, but half-a-grid staggered and at z 100/101/102 —
    // above every disjoint grid (z 0..GRIDS-1) and above each other in id order. So the correct
    // picture is unambiguous (ov2 over ov1 over ov0 over the row beneath), and a plate that fails
    // to occlude is a defect you can point at rather than argue about.
    for (let i = 0; i < OVERLAP_GRIDS; i++) {
      tints.push(OVERLAP_BG[i])
      handles.push(
        engine.register({
          id: `ov${i}`,
          cols: COLS,
          rows: ROWS,
          cellW: CELL_W,
          cellH: CELL_H,
          originX: OVERLAP_X0 + i * OVERLAP_STEP_X,
          originY: OVERLAP_Y0 + i * OVERLAP_STEP_Y,
          z: 100 + i,
          bgColor: OVERLAP_BG[i],
          padPx: PAD_PX
        })
      )
    }

    const row = new Uint32Array(COLS * CELL_STRIDE)
    const feed = setInterval(() => {
      for (let g = 0; g < handles.length; g++) {
        const h = handles[g]
        const bg = tints[g]
        for (let c = 0; c < COLS; c++) {
          // 0x21..0x7a — printable ASCII, so String.fromCodePoint in the rasterizer always
          // gets a valid code point.
          const code = 0x21 + Math.floor(Math.random() * 90)
          writeCell(
            row,
            c,
            // The glyph lane is an ATLAS SLOT, never a raw code point.
            atlas.glyphFor(code, Math.random() < 0.1, false),
            packColor(180 + Math.floor(Math.random() * 75), 200, 160, 255),
            bg,
            Math.random() < 0.05 ? FLAG_BOLD : 0
          )
        }
        h.updateRow(Math.floor(Math.random() * ROWS), row)
      }
    }, 33)

    // Open framing ALL 43 grids — see fitCamera. WORLD_W/WORLD_H are still derived from the 40
    // disjoint ones alone, and that is correct, not an oversight: the overlap cluster is placed
    // inside their bounding box (see OVERLAP_X0/Y0 above), so the total extents are unchanged and
    // the fitted opening view contains every registered grid.
    // Deliberately not recomputed on resize: once the
    // tester has panned/zoomed, a resize must not yank the camera back out from under them.
    const cam = fitCamera(window.innerWidth, window.innerHeight)
    engine.setCamera(cam)
    let drag: { x: number; y: number } | null = null
    const onDown = (e: MouseEvent): void => {
      drag = { x: e.clientX - cam.x, y: e.clientY - cam.y }
    }
    const onUp = (): void => {
      drag = null
    }
    const onMove = (e: MouseEvent): void => {
      if (!drag) return
      cam.x = e.clientX - drag.x
      cam.y = e.clientY - drag.y
      engine.setCamera(cam)
    }
    const onWheel = (e: WheelEvent): void => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.zoom * (e.deltaY < 0 ? 1.1 : 0.9)))
      // zoom around the cursor: keep the world point under the cursor fixed
      cam.x = e.clientX - ((e.clientX - cam.x) / cam.zoom) * next
      cam.y = e.clientY - ((e.clientY - cam.y) / cam.zoom) * next
      cam.zoom = next
      engine.setCamera(cam)
    }
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('mousemove', onMove)
    canvas.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('resize', applyViewport)

    let frames = 0
    let draws = 0
    let raf = 0
    const loop = (): void => {
      frames++
      if (engine.frame()) draws++
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    const meter = setInterval(() => {
      // The DRAWN count, not the registered one: the engine culls per frame, so `GRIDS` alone
      // would advertise a load the fps figure was never measured under. drawOrder() is pure and
      // public, and once a second its allocate-filter-sort is free.
      const drawn = engine.drawOrder().length
      setStats(
        `${frames} fps · ${draws} draws/s · ${rowsUploaded} rows-up/s · ` +
          `zoom ${cam.zoom.toFixed(2)} · ${drawn}/${TOTAL_GRIDS} grids drawn · 1 context`
      )
      frames = 0
      draws = 0
      rowsUploaded = 0
    }, 1000)

    return () => {
      cancelAnimationFrame(raf)
      clearInterval(feed)
      clearInterval(meter)
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('wheel', onWheel)
      window.removeEventListener('resize', applyViewport)
      // Handles first, then the context: the engine instance itself is dropped with this
      // closure, so the next effect run starts from an empty registry.
      for (const h of handles) h.dispose()
      gl.dispose()
    }
  }, [])

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }}>
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          color: '#8f8',
          font: '12px monospace',
          // Overlay is read-only: never swallow a mousedown/wheel meant for the canvas below.
          pointerEvents: 'none'
        }}
      >
        {stats}
      </div>
    </div>
  )
}
