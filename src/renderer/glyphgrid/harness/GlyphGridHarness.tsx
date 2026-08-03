// Dev-only proving ground for the glyphgrid engine: 40 synthetic 80x24 terminals, streaming
// random lines at ~30Hz, camera drag+wheel-zoom, FPS + draw counters. THE Phase-0 acceptance
// gate: 60fps pan/zoom, idle frames drawing nothing, one WebGL context total.
//
// It opens with all 40 grids framed and reports how many it is actually DRAWING, so the fps
// figure a tester signs off on is always attributable to a known load — the engine culls, and
// both of those were once free to lie in opposite directions.
//
// Reached only through the dev route in src/renderer/main.tsx
// (`import.meta.env.DEV && location.hash === '#glyphgrid'`), so this module is dead code in a
// production build — see the report for the verified chunk split.
import { useEffect, useRef, useState } from 'react'
import { GlyphAtlas } from '../atlas'
import { packColor, writeCell, CELL_STRIDE, FLAG_BOLD } from '../cells'
import { GlyphGridEngine, type GridHandle } from '../engine'
import { createWebgl2GL } from '../gl-webgl2'
import { createCanvasRasterizer } from '../raster'

const COLS = 80
const ROWS = 24
const GRIDS = 40
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
    const gl = createWebgl2GL(canvas)
    if (!gl) {
      setStats('WebGL2 unavailable')
      return
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
    for (let i = 0; i < GRIDS; i++) {
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
          bgColor: packColor(20, 20, 24, 255),
          // Non-zero so the occlusion plate is actually VISIBLE in the harness: it extends the
          // opaque body past the character matrix, the way a terminal node's padding does.
          padPx: PAD_PX
        })
      )
    }

    const row = new Uint32Array(COLS * CELL_STRIDE)
    const feed = setInterval(() => {
      for (const h of handles) {
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
            packColor(20, 20, 24, 255),
            Math.random() < 0.05 ? FLAG_BOLD : 0
          )
        }
        h.updateRow(Math.floor(Math.random() * ROWS), row)
      }
    }, 33)

    // Open framing ALL 40 grids — see fitCamera. Deliberately not recomputed on resize: once the
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
        `${frames} fps · ${draws} draws/s · zoom ${cam.zoom.toFixed(2)} · ` +
          `${drawn}/${GRIDS} grids drawn · 1 context`
      )
      frames = 0
      draws = 0
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
