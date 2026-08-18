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
/**
 * How far each synthetic grid's PLATE overhangs its character matrix, in world units.
 *
 * The plate is an INDEPENDENT rect now (the node BODY, which is larger than the matrix — see
 * `GridDrawParams.plateX`), so the harness has to keep supplying one that is genuinely bigger than
 * the grid or it would exercise a case the app never runs: a plate-sized-to-grid draws no band, and
 * the overlap trio's occlusion would be judged on the matrices alone. Asymmetric on purpose — 8
 * left/top, 8 + SLACK right/bottom — because the defect this replaced (`padPx`, one symmetric
 * scalar) was invisible precisely at the right and bottom, where a real terminal's fit slack lives.
 *
 * Well under the 40/60 layout pitch, so the 40 disjoint plates still stay separated.
 */
const PLATE_PAD = 8
/** The extra right/bottom overhang, standing in for the fit slack a real body leaves. */
const PLATE_SLACK = 10

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
/**
 * The foreground palette the synthetic feed draws from — FOUR entries, and the count is
 * load-bearing.
 *
 * The atlas is keyed by colour (Phase 1c), so the key space this harness generates is
 * `codes x bold x fg x bg` = 90 x 2 x 4 x 4 = 2880, against a capacity of 3588 slots
 * (1024px page, 13x22 pitch). A random fg per cell — what this used to do — puts the key space at
 * ~54k and the page then RESETS several times a second: 30+ full-page clears per second, and every
 * already-uploaded lane pointing at a recycled slot, i.e. a screen of permanently wrong glyphs.
 * This harness feeds the engine DIRECTLY — it is not an xterm terminal, so it has no renderer addon
 * and therefore no reset subscriber to repack it (see GlyphAtlas.onReset). That is a broken
 * harness, not a stress test.
 */
const FG_PALETTE = [
  packColor(200, 200, 160, 255),
  packColor(160, 210, 200, 255),
  packColor(220, 170, 170, 255),
  packColor(180, 200, 240, 255)
]
/** ATLAS RESET STRESS. Flip to true to give every cell a random foreground, which blows the key
 *  space past the page's capacity and exercises reset-on-full continuously. Deliberately a manual
 *  switch: with it on the glyphs on screen are expected to be WRONG (this harness subscribes to no
 *  reset, see above), so it is a test of the reset MACHINERY, never of rendering quality. */
const ATLAS_RESET_STRESS = false
/** A little air around the fitted layout, so the outermost grids are visibly INSIDE the frame
 *  rather than clipping its edge — the tester has to be able to count them. */
const FIT_MARGIN = 0.92
const ZOOM_MIN = 0.05
const ZOOM_MAX = 4

/** The plate rect for a grid whose matrix starts at (x, y): the matrix plus PLATE_PAD on every
 *  side and PLATE_SLACK more on the right and bottom. One helper so the two register loops below
 *  cannot drift apart. */
function plateFor(x: number, y: number): { plateX: number; plateY: number; plateW: number; plateH: number } {
  return {
    plateX: x - PLATE_PAD,
    plateY: y - PLATE_PAD,
    plateW: COLS * CELL_W + 2 * PLATE_PAD + PLATE_SLACK,
    plateH: ROWS * CELL_H + 2 * PLATE_PAD + PLATE_SLACK
  }
}

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
      { family: 'monospace', sizePx: 14, cellW: CELL_W, cellH: CELL_H, weight: 400, weightBold: 700 },
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
      const x = (i % PER_ROW) * PITCH_X
      const y = Math.floor(i / PER_ROW) * PITCH_Y
      handles.push(
        engine.register({
          id: `t${i}`,
          cols: COLS,
          rows: ROWS,
          cellW: CELL_W,
          cellH: CELL_H,
          originX: x,
          originY: y,
          z: i,
          bgColor: BASE_BG,
          // Larger than the matrix so the occlusion plate is actually VISIBLE in the harness: it
          // is the opaque BODY the terminal paints under itself, the way a node's body is.
          ...plateFor(x, y)
        })
      )
    }
    // The overlap cluster: same size, same feed, but half-a-grid staggered and at z 100/101/102 —
    // above every disjoint grid (z 0..GRIDS-1) and above each other in id order. So the correct
    // picture is unambiguous (ov2 over ov1 over ov0 over the row beneath), and a plate that fails
    // to occlude is a defect you can point at rather than argue about.
    for (let i = 0; i < OVERLAP_GRIDS; i++) {
      tints.push(OVERLAP_BG[i])
      const x = OVERLAP_X0 + i * OVERLAP_STEP_X
      const y = OVERLAP_Y0 + i * OVERLAP_STEP_Y
      handles.push(
        engine.register({
          id: `ov${i}`,
          cols: COLS,
          rows: ROWS,
          cellW: CELL_W,
          cellH: CELL_H,
          originX: x,
          originY: y,
          z: 100 + i,
          bgColor: OVERLAP_BG[i],
          // Same oversized plate as the disjoint grids — and here it is what the trio is FOR: a
          // higher-z member's plate must bury the band of the member below it, not just its cells.
          ...plateFor(x, y)
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
          // Resolved BEFORE the atlas request: the atlas is keyed by colour, so the slot and the
          // lane have to be asked for with the same pair — and from a BOUNDED palette, or the key
          // space outgrows the page (see FG_PALETTE / ATLAS_RESET_STRESS).
          const fg = ATLAS_RESET_STRESS
            ? packColor(180 + Math.floor(Math.random() * 75), 200, 160, 255)
            : FG_PALETTE[Math.floor(Math.random() * FG_PALETTE.length)]
          writeCell(
            row,
            c,
            // The glyph lane is an ATLAS SLOT, never a raw code point.
            atlas.glyphFor(code, Math.random() < 0.1, false, fg, bg),
            fg,
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
      // would advertise a load the fps figure was never measured under. Once a second its
      // allocate-filter-sort is free. Its one side effect — refreshing each grid's cached
      // visibility — is idempotent against the camera this loop last drew with, so an out-of-band
      // call here can only write the answer the next frame would have written anyway.
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
