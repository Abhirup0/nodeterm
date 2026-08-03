// Dev-only proving ground for the glyphgrid engine: 40 synthetic 80x24 terminals, streaming
// random lines at ~30Hz, camera drag+wheel-zoom, FPS + draw counters. THE Phase-0 acceptance
// gate: 60fps pan/zoom, idle frames drawing nothing, one WebGL context total.
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
    // Viewport is set on mount and on resize ONLY — setViewport is not change-gated and resets
    // the drawing buffer, so calling it per rAF tick would reallocate the backing store 60x/s.
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
          originX: (i % 8) * (COLS * CELL_W + 40),
          originY: Math.floor(i / 8) * (ROWS * CELL_H + 60),
          z: i,
          bgColor: packColor(20, 20, 24, 255)
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

    const cam = { x: 40, y: 40, zoom: 1 }
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
      const next = Math.min(4, Math.max(0.05, cam.zoom * (e.deltaY < 0 ? 1.1 : 0.9)))
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
      setStats(
        `${frames} fps · ${draws} draws/s · zoom ${cam.zoom.toFixed(2)} · ${GRIDS} grids · 1 context`
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
      <div style={{ position: 'absolute', top: 8, left: 8, color: '#8f8', font: '12px monospace' }}>
        {stats}
      </div>
    </div>
  )
}
