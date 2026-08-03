/**
 * The MOUNTING SURFACE of the glyphgrid renderer (Phase 1b): the one WebGL2 canvas every
 * terminal on the board paints into, the rAF driver that submits its frames, and the two feeds
 * the canvas owns — the camera and the node paint order.
 *
 * Three things live here and nowhere else:
 *
 * 1. **The engine singleton.** ONE GL context for the whole canvas is the entire point of the
 *    shared renderer (the per-terminal path fights Chromium's ~16-context cap through
 *    `terminal/webgl-budget.ts`; see the WebGL section of CLAUDE.md). So the context is a module
 *    singleton, not component state: it must survive `<SharedGlyphLayer/>` remounting, and it is
 *    created LAZILY — a user who never turns the experimental mode on must never cost a GPU
 *    context, which is why `getSharedGlyphContext()` returns null while the mode is off.
 * 2. **The failure path.** `GlyphGridEngine.frame()` RETHROWS on a GL error by contract (it
 *    restores its damage first), and a lost context is not recoverable in 1b. Both land on
 *    `failSharedGlyph()`: warn once, tear the context down, and flip the store's `failed` — the
 *    session-level "everyone back to the DOM renderer" signal that TerminalNode reads.
 * 3. **The seams the rest of the integration reads**: `useSharedGlyph` (mode + generation +
 *    failure), `setNodeZOrder`/`nodeZFor`/`subscribeNodeZOrder` (paint order), and
 *    `setSharedGlyphCamera` (pan/zoom). Every one of them is a no-op while no context exists, so
 *    Canvas can call them unconditionally and a default-mode user pays a null check.
 *
 * The component and the GL singleton have NO unit tests by design — there is no WebGL2, no
 * OffscreenCanvas and no layout in vitest's node environment. The pure parts (order signature,
 * store transitions, z map) are tested; the rest is on the T6 device checklist. That split is the
 * same one `terminal/glyphgrid-attach.ts` makes for xterm's internals.
 */

import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { GlyphAtlas } from '../glyphgrid/atlas'
import type { Camera } from '../glyphgrid/camera'
import { GlyphGridEngine } from '../glyphgrid/engine'
import type { GlyphGL } from '../glyphgrid/gl'
import { createWebgl2GL } from '../glyphgrid/gl-webgl2'
import { createCanvasRasterizer } from '../glyphgrid/raster'
import { useSettings } from '../state/settings'

/** Atlas page edge, in DEVICE pixels. 2048 (not Phase 0's 1024) because the atlas cells are
 *  device-sized: at dpr 2 a 13px terminal font is roughly a 16x38 device cell, so a 1024 page
 *  holds ~1600 glyphs — enough for ASCII plus a little, and nothing like enough for a session
 *  that also shows box drawing, powerline glyphs and CJK. A full page degrades to the blank slot
 *  (GlyphAtlas never throws), i.e. missing text, so the page is sized for the pathological
 *  session rather than the average one. 2048² RGBA = 16 MB of VRAM, once, for the whole canvas. */
const ATLAS_PAGE_PX = 2048

/** Fallback cell metrics as a fraction of the font size, used only when the 2D context cannot
 *  measure (no OffscreenCanvas → we bail before this, or a font that reports nothing). Roughly a
 *  monospace advance and line box. */
const FALLBACK_ADVANCE_RATIO = 0.6
const FALLBACK_LINE_RATIO = 1.2
/** A cell larger than this would make the atlas page hold almost nothing; clamped rather than
 *  trusted, since the ratio comes from a user-typed font family. */
const MAX_CELL_PX = 256

// ---------------------------------------------------------------------------------------------
// Store — the reactive half of the seam
// ---------------------------------------------------------------------------------------------

interface SharedGlyphState {
  /** Resolved renderer mode is 'shared'. Set by App.tsx (T6); false for every user today, which
   *  is what keeps this whole module inert. */
  enabled: boolean
  /** Bumped whenever every registered grid must let go and re-evaluate: the context was rebuilt
   *  (font change), the mode was turned off, or the session failed. TerminalNode subscribes to
   *  exactly this number — the context it then asks for answers what to do next (a new engine, or
   *  null = back to the DOM renderer). */
  generation: number
  /** Session-level "the shared renderer is off for good" — set by the rAF catch or a lost
   *  context. Deliberately NOT auto-cleared: a GPU that just threw at us gets one chance per app
   *  run, and a retry loop is how you turn a bad driver into a flicker. */
  failed: boolean
  setEnabled(on: boolean): void
  bumpGeneration(): void
  markFailed(): void
}

export const useSharedGlyph = create<SharedGlyphState>((set, get) => ({
  enabled: false,
  generation: 0,
  failed: false,
  setEnabled(on) {
    if (get().enabled === on) return
    set({ enabled: on })
    if (on) return
    // Turning the mode OFF hands the GPU context back. The whole point of the shared renderer is
    // that contexts are scarce (see terminal/webgl-budget.ts), so leaving one — plus a 16 MB
    // atlas — parked for a mode the user just left would be the exact cost this feature exists to
    // remove. Turning it ON creates nothing: the first terminal that asks does that, lazily.
    disposeContext()
    // ...and the disposal MUST be announced. Every registered grid is now holding an inert handle;
    // without the bump a terminal that subscribes to `generation` alone would keep writing rows
    // into nothing and stay blank until it remounted. Same one-signal contract the failure path
    // honors — never dispose the context without bumping.
    set({ generation: get().generation + 1 })
  },
  bumpGeneration() {
    set({ generation: get().generation + 1 })
  },
  markFailed() {
    // Delegates so that "the session failed" has exactly ONE implementation: warn once, drop the
    // context, then flip the flag. A store action that only flipped the flag would be a reachable
    // half-failure — the flag set, the GPU context still held — and it is the shape a caller
    // naturally reaches for.
    failSharedGlyph('marked failed')
  }
}))

/** Non-reactive gate for the imperative call sites (TerminalNode's register path). */
export function sharedGlyphActive(): boolean {
  const s = useSharedGlyph.getState()
  return s.enabled && !s.failed
}

/** Reactive form of `sharedGlyphActive()` — Canvas mounts the layer on this. */
export function useSharedGlyphActive(): boolean {
  return useSharedGlyph((s) => s.enabled && !s.failed)
}

// ---------------------------------------------------------------------------------------------
// Node paint order
// ---------------------------------------------------------------------------------------------

/** The separator for the order signature. NUL cannot occur in a node id (they are nanoid/uuid
 *  shaped), so `split` is an exact inverse of `join`. */
const ORDER_SEP = '\u0000'

let zOrder = new Map<string, number>()
let zOrderSig = ''
const zListeners = new Set<() => void>()

/**
 * The paint order of the TERMINAL nodes, as one string. Canvas recomputes it per nodes change and
 * only pushes when it differs — a string compare instead of an array diff, the same trick the
 * data-signature effect next to it uses.
 *
 * Only terminals: they are the only kind that registers a grid, and mixing other kinds in would
 * churn the signature on every sticky edit.
 *
 * **The rule is array order, with SELECTED nodes elevated above unselected ones** (stable within
 * each group) — not array order alone. React Flow's `elevateNodesOnSelect` defaults to true, so
 * selecting a node lifts its DOM z-index to 1000 regardless of where it sits in the array. With a
 * grid z that only followed the array, clicking a terminal that overlaps another would raise its
 * chrome while its TEXT stayed underneath the other grid's opaque plate — the node visibly on top
 * with a hole punched through its glyphs. Mirroring the elevation here is what keeps the canvas and
 * the DOM telling the same story.
 */
export function nodeOrderSig(
  nodes: readonly { id: string; type?: string; selected?: boolean }[]
): string {
  let base = ''
  let elevated = ''
  for (const n of nodes) {
    if (n.type !== 'terminal') continue
    if (n.selected) elevated = elevated === '' ? n.id : elevated + ORDER_SEP + n.id
    else base = base === '' ? n.id : base + ORDER_SEP + n.id
  }
  if (base === '') return elevated
  if (elevated === '') return base
  return base + ORDER_SEP + elevated
}

export function idsFromOrderSig(sig: string): string[] {
  return sig === '' ? [] : sig.split(ORDER_SEP)
}

/** Publish the terminal paint order. Change-gated on the joined signature: the registered grids
 *  re-read their z from the notification, and re-pushing an unchanged order would walk every
 *  terminal on the canvas for nothing. */
export function setNodeZOrder(ids: readonly string[]): void {
  const sig = ids.join(ORDER_SEP)
  if (sig === zOrderSig) return
  zOrderSig = sig
  const next = new Map<string, number>()
  ids.forEach((id, i) => next.set(id, i))
  zOrder = next
  for (const fn of zListeners) fn()
}

/** The z a grid should carry. An id we have not been told about yet lands on TOP: a node created
 *  between two order pushes is appended last on the canvas, so "topmost" matches what the user
 *  sees, while 0 would flash it underneath every other terminal for a frame. */
export function nodeZFor(id: string): number {
  const z = zOrder.get(id)
  return z === undefined ? zOrder.size : z
}

/** Grid owners subscribe here and re-read `nodeZFor` — the engine change-gates `setZ`, so a
 *  no-op reorder costs one comparison per grid. */
export function subscribeNodeZOrder(fn: () => void): () => void {
  zListeners.add(fn)
  return () => {
    zListeners.delete(fn)
  }
}

// ---------------------------------------------------------------------------------------------
// The engine singleton
// ---------------------------------------------------------------------------------------------

export interface SharedGlyphContext {
  engine: GlyphGridEngine
  atlas: GlyphAtlas
}

interface LiveContext extends SharedGlyphContext {
  canvas: HTMLCanvasElement
  gl: GlyphGL
  /** Font settings this context was rasterized for — a change tears it down. */
  fontKey: string
  /** Set by `disposeContext`, read by the rAF driver, which holds this object across a frame.
   *  Teardown is SYNCHRONOUS (a settings change, the mode being switched off) and can land
   *  between a scheduled tick and its callback — a frame submitted after `gl.dispose()` would
   *  throw against deleted GPU objects, and the driver's catch would read that as a GPU failure
   *  and burn the whole session. A font-size change must not be able to disable the renderer. */
  disposed: boolean
}

let live: LiveContext | null = null
/** One creation attempt per context lifetime (reset by `disposeContext`). Without it every
 *  terminal mount would re-probe a machine that has already said "no WebGL2", and each probe is a
 *  real `getContext` call. */
let creationAttempted = false
let settingsUnsub: (() => void) | null = null
/** The camera survives teardown so a rebuilt context opens where the user is looking, and so
 *  Canvas can feed the camera before the layer has ever mounted (the project-load seed runs
 *  first). Recording it is three number writes — cheaper than the null check it replaces. */
let lastCamera: Camera = { x: 0, y: 0, zoom: 1 }

function fontKeyOf(fontFamily: string, fontSize: number): string {
  return `${fontFamily}|${fontSize}`
}

/**
 * The atlas cell, in DEVICE pixels.
 *
 * Deliberately NOT xterm's measurement. xterm measures the advance of 'W' in a live DOM span per
 * terminal (`_charSizeService`), and the addon feeds those exact numbers to the ENGINE as the
 * grid's cell size — so cell GEOMETRY on screen is always xterm's own, and mouse coordinates
 * stay aligned. The number computed here decides only how many texels a glyph is rasterized
 * into; a fraction of a pixel of disagreement rescales the bitmap slightly, it can never move a
 * cell. Measuring here through the DOM instead would mean creating and laying out a probe
 * element from a module singleton before any terminal exists, for a strictly cosmetic gain.
 *
 * Rounded UP because every draw is clipped to its slot rect (see raster.ts): a slot a hair too
 * small clips the glyph, a slot a hair too big wastes atlas area.
 */
function measureCellDevicePx(family: string, sizePx: number): { cellW: number; cellH: number } {
  const fallback = {
    cellW: Math.max(1, Math.ceil(sizePx * FALLBACK_ADVANCE_RATIO)),
    cellH: Math.max(1, Math.ceil(sizePx * FALLBACK_LINE_RATIO))
  }
  try {
    const ctx = new OffscreenCanvas(8, 8).getContext('2d')
    if (!ctx) return fallback
    ctx.font = `${sizePx}px ${family}`
    const m = ctx.measureText('W')
    // `fontBoundingBox*` is the FONT's line box, not this glyph's ink box — the right metric for
    // a cell, and the one that keeps descenders inside their slot. Guarded because it is
    // optional in the spec (and undefined in some engines).
    const ascent = m.fontBoundingBoxAscent
    const descent = m.fontBoundingBoxDescent
    const w = Math.ceil(m.width)
    const h = Number.isFinite(ascent) && Number.isFinite(descent) ? Math.ceil(ascent + descent) : 0
    return {
      cellW: w > 0 ? Math.min(w, MAX_CELL_PX) : fallback.cellW,
      cellH: h > 0 ? Math.min(h, MAX_CELL_PX) : fallback.cellH
    }
  } catch {
    return fallback
  }
}

function createContext(): LiveContext | null {
  if (typeof document === 'undefined' || typeof OffscreenCanvas === 'undefined') return null
  const { fontFamily, fontSize } = useSettings.getState().settings
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  // The atlas is rasterized at DEVICE resolution: the addon reports device-pixel cells, and a
  // CSS-sized atlas would be visibly soft on every retina display. The dpr is read ONCE, and
  // deliberately does not join the font key: moving the window to a monitor with a different dpr
  // leaves the glyphs rasterized for the old one (slightly soft or slightly over-sampled), which
  // is a Phase-2 sharpness question — rebuilding the atlas there would drop and re-register every
  // grid on the canvas for a cosmetic gain. The drawing BUFFER does follow the dpr, on every
  // resize (see the component's `pushViewport`), so geometry is never wrong.
  const devicePx = Math.max(1, fontSize * dpr)
  const { cellW, cellH } = measureCellDevicePx(fontFamily, devicePx)
  // Rasterizer FIRST: it needs no GPU, so a missing OffscreenCanvas bails out before a WebGL
  // context has been created (the harness learned this the expensive way — a context acquired
  // and then dropped unreferenced is exactly the leak this whole layer exists to avoid).
  const raster = createCanvasRasterizer(
    { family: fontFamily, sizePx: devicePx, cellW, cellH },
    ATLAS_PAGE_PX
  )
  if (!raster) return null
  const canvas = document.createElement('canvas')
  canvas.className = 'glyphgrid-canvas'
  // The GL layer sizes the BACKING STORE (canvas.width/height in device px); the CSS box is ours.
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none'
  const gl = createWebgl2GL(canvas)
  if (!gl) return null
  const atlas = new GlyphAtlas(raster, ATLAS_PAGE_PX)
  const engine = new GlyphGridEngine(gl, atlas)
  engine.setCamera(lastCamera)
  return { engine, atlas, canvas, gl, fontKey: fontKeyOf(fontFamily, fontSize), disposed: false }
}

/** Tear the context down and free the GPU objects. Every registered grid is left holding an
 *  INERT handle (`disposeAll`'s contract), so a terminal that writes one more row during
 *  teardown is a no-op rather than a throw. */
function disposeContext(): void {
  const ctx = live
  live = null
  creationAttempted = false
  if (!ctx) return
  // BEFORE any GL call: a rAF tick already scheduled with this context must skip its frame rather
  // than submit against deleted objects (see `LiveContext.disposed`).
  ctx.disposed = true
  try {
    ctx.engine.disposeAll()
    ctx.gl.dispose()
    // `gl.dispose()` frees the buffers/texture/program but NOT the context itself, and the
    // browser's live-context cap counts contexts, not objects. A rebuild creates a fresh canvas
    // (a canvas hands back the same context forever), so the old one must be explicitly lost or
    // every font change permanently spends one of the ~16 slots the whole app shares.
    const raw = ctx.canvas.getContext('webgl2')
    raw?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch (err) {
    console.warn('[glyphgrid] teardown error (continuing)', err)
  }
  ctx.canvas.remove()
}

/** Warn, drop the context, and put the session on the DOM renderer. The ONE failure funnel — the
 *  store's `markFailed()` delegates here, and this writes the flag DIRECTLY (calling back into the
 *  action would recurse). */
export function failSharedGlyph(reason: string, err?: unknown): void {
  // Checked before the warn so a lost context that arrives twice (throwing frame + event) logs
  // once, and so a second failure never re-notifies the registrants.
  const store = useSharedGlyph.getState()
  if (store.failed) return
  console.warn(`[glyphgrid] shared renderer disabled for this session (${reason})`, err)
  disposeContext()
  // The generation rides along so a node that only subscribes to `generation` still wakes up —
  // it will ask for the context, get null, and stay on the DOM renderer. One signal, one
  // subscription.
  useSharedGlyph.setState({ failed: true, generation: useSharedGlyph.getState().generation + 1 })
}

/** Rebuild on a terminal font change: the atlas is rasterized for one font, so a new one means a
 *  new atlas — and the engine's grids are re-registered by their owners on the generation bump.
 *
 *  Never unsubscribed, deliberately: the context it watches is a module singleton with no owner
 *  to outlive, and a subscription dropped at teardown would miss the font change that happens
 *  while the mode is momentarily off. It is one closure for the life of the renderer process. */
function ensureSettingsSubscription(): void {
  if (settingsUnsub) return
  settingsUnsub = useSettings.subscribe((s) => {
    if (!live) return
    if (live.fontKey === fontKeyOf(s.settings.fontFamily, s.settings.fontSize)) return
    disposeContext()
    useSharedGlyph.getState().bumpGeneration()
  })
}

/** The singleton, created on first use. Internal because it also exposes the canvas + GL, which
 *  only this file's component may touch. */
function ensureLiveContext(): LiveContext | null {
  if (!sharedGlyphActive()) return null
  if (live) return live
  if (creationAttempted) return null
  creationAttempted = true
  ensureSettingsSubscription()
  live = createContext()
  return live
}

/**
 * The shared engine + atlas, created on first use. Null means "stay on the DOM renderer": the
 * mode is off, the session has failed, or this machine has no WebGL2/OffscreenCanvas.
 */
export function getSharedGlyphContext(): SharedGlyphContext | null {
  return ensureLiveContext()
}

/** Camera feed. Always records (so a context created later opens at the right place) and only
 *  reaches the engine — which change-gates it — when one exists. */
export function setSharedGlyphCamera(cam: Camera): void {
  lastCamera = { x: cam.x, y: cam.y, zoom: cam.zoom }
  live?.engine.setCamera(lastCamera)
}

// ---------------------------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------------------------

/**
 * Hosts the shared canvas inside the React Flow pane and drives its frames.
 *
 * **Stacking.** React Flow's own layers, from `@xyflow/react`'s base.css: `.react-flow__background`
 * is z-index -1 and `.react-flow__renderer` (which contains the pane and the transformed viewport
 * holding every node) is z-index 4, all inside the `.react-flow` wrapper's own stacking context.
 * Children passed to `<ReactFlow>` — this component, like `<Background/>` — render as siblings of
 * both. z-index 0 therefore puts the glyph canvas ABOVE the dot grid and BELOW the nodes, which is
 * where it has to be: node bodies stay opaque in v1, so the DOM keeps owning node chrome and
 * stacking, and the canvas only orders grids among themselves.
 *
 * **Not inside the viewport.** The canvas is screen-space — the engine applies the camera itself
 * in the shader — so it must not sit under React Flow's CSS transform, which would scale its
 * pixels instead.
 */
export function SharedGlyphLayer(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const generation = useSharedGlyph((s) => s.generation)
  const failed = useSharedGlyph((s) => s.failed)

  useEffect(() => {
    const host = hostRef.current
    if (!host || failed) return
    const ctx = ensureLiveContext()
    if (!ctx) return
    const canvas = ctx.canvas
    host.appendChild(canvas)

    const pushViewport = (): void => {
      // The engine change-gates all three inputs, so calling this from every observer tick is
      // free when nothing actually moved.
      ctx.engine.setViewport(
        host.clientWidth,
        host.clientHeight,
        typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
      )
    }
    pushViewport()

    // ResizeObserver, not just window resize: the pane also changes size when a drawer or the
    // sessions sidebar opens, and a stale viewport culls the wrong grids.
    const ro = new ResizeObserver(pushViewport)
    ro.observe(host)
    // ...and window resize on top of it, because a DPR change (dragging the window to a second
    // monitor) leaves the CSS box identical while the backing store must change.
    window.addEventListener('resize', pushViewport)

    let raf = 0
    const tick = (): void => {
      // The context can be torn down synchronously between the schedule and this callback (font
      // change, mode switched off). Skipping the frame — and NOT rescheduling — leaves the loop to
      // the effect run that the accompanying generation bump triggers; the cleanup below cancels
      // this handle either way.
      if (ctx.disposed) return
      try {
        ctx.engine.frame()
      } catch (err) {
        // `frame()` rethrows by contract, having restored its own damage. There is no recovery in
        // 1b: the whole session goes back to the DOM renderer.
        failSharedGlyph('frame threw', err)
        return // no reschedule — the cleanup below still cancels the (already fired) handle
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    // Phase 2 owns real context restoration; here a lost context is simply the end of the shared
    // renderer for this session. `preventDefault()` is deliberately NOT called — that is the
    // "please fire webglcontextrestored" request, and we have nothing to restore into.
    const onLost = (): void => failSharedGlyph('context lost')
    canvas.addEventListener('webglcontextlost', onLost)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', pushViewport)
      canvas.removeEventListener('webglcontextlost', onLost)
      // The canvas leaves the DOM with the host div; the CONTEXT stays alive for the next mount
      // (a project switch must not cost a context rebuild). Only `failSharedGlyph` and a font
      // change dispose it.
    }
  }, [generation, failed])

  return (
    <div
      ref={hostRef}
      className="glyphgrid-layer"
      style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}
    />
  )
}
