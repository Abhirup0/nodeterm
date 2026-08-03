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

import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { GlyphAtlas } from '../glyphgrid/atlas'
import type { Camera } from '../glyphgrid/camera'
import { GlyphGridEngine } from '../glyphgrid/engine'
import type { GlyphGL } from '../glyphgrid/gl'
import { createWebgl2GL } from '../glyphgrid/gl-webgl2'
import { createCanvasRasterizer } from '../glyphgrid/raster'
import { useSettings } from '../state/settings'

/** Atlas page edge, in DEVICE pixels. 2048 (not Phase 0's 1024) because the atlas cells are
 *  device-sized: at dpr 2 a 13px terminal font is roughly a 16x32 device cell, so a 1024 page
 *  holds ~2000 glyphs — enough for ASCII plus a little, and nothing like enough for a session
 *  that also shows box drawing, powerline glyphs and CJK. A full page degrades to the blank slot
 *  (GlyphAtlas never throws), i.e. missing text, so the page is sized for the pathological
 *  session rather than the average one. 2048² RGBA = 16 MB of VRAM, once, for the whole canvas. */
const ATLAS_PAGE_PX = 2048

/** A cell larger than this would make the atlas page hold almost nothing. The number now comes
 *  from xterm rather than from a measurement of a user-typed font family, so this is a sanity
 *  clamp on a pathological font size rather than a guard against a bad guess. */
const MAX_CELL_PX = 256

/**
 * The cell the atlas rasterizes into, in DEVICE pixels.
 *
 * **The invariant: the atlas texel grid IS xterm's device cell grid, always.** The engine draws a
 * cell as `css.cell × zoom` onto a dpr-scaled buffer, i.e. `device.cell` device pixels at zoom 1,
 * and the atlas slot is stretched over exactly that quad. Any disagreement between the two is a
 * per-glyph resample — the "text is rougher than the DOM renderer" report. So the atlas does not
 * measure anything itself: the first terminal to build the context hands over xterm's own
 * `dimensions.device.cell`, which already carries xterm's rounding chain (charSize × dpr, ceil on
 * the char height, letterSpacing, lineHeight).
 *
 * One cell for the whole canvas is correct because the font settings are GLOBAL — every terminal
 * computes the same device cell from the same font family/size and the same dpr.
 */
export interface DeviceCell {
  cellW: number
  cellH: number
}

// ---------------------------------------------------------------------------------------------
// Store — the reactive half of the seam
// ---------------------------------------------------------------------------------------------

interface SharedGlyphState {
  /** Resolved renderer mode is 'shared'. Written only by `applyRendererMode` (App.tsx), and false
   *  unless the user opted into the experimental mode — which is what keeps this whole module
   *  inert for everyone else. */
  enabled: boolean
  /** Bumped whenever every mounted terminal must re-evaluate its participation: the mode was
   *  turned ON, the context was rebuilt (font change), the mode was turned off, or the session
   *  failed. TerminalNode subscribes to exactly this number — the context it then asks for
   *  answers what to do next (a new engine, or null = back to the DOM renderer). */
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
    if (on) {
      // Turning the mode ON creates nothing — the first terminal that asks builds the context,
      // lazily — but it must still be ANNOUNCED, in the same single set() so the notification
      // carries the new `enabled` alongside the bump. Every mounted terminal re-evaluates its
      // participation on a generation change; without the bump here, flipping the setting with a
      // canvas full of live terminals would do nothing visible until each of them remounted (a
      // project switch), and the setting would look broken. Safe for a node that has never
      // registered a grid: its teardown is a no-op and its re-setup is the same gated
      // `setupGlyph()` a fresh mount runs.
      set({ enabled: true, generation: get().generation + 1 })
      return
    }
    set({ enabled: on })
    // Turning the mode OFF hands the GPU context back. The whole point of the shared renderer is
    // that contexts are scarce (see terminal/webgl-budget.ts), so leaving one — plus a 16 MB
    // atlas — parked for a mode the user just left would be the exact cost this feature exists to
    // remove.
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

/**
 * Will this canvas paint terminals into the shared context — whether or not one has been BUILT
 * yet? This, not the presence of a context object, is the question a terminal asks when deciding
 * which renderer it belongs to (and therefore whether it takes a WebGL budget client).
 *
 * Deliberately non-creating, and deliberately NOT `getSharedGlyphContext(…) !== null`. Since the
 * atlas adopts a live terminal's device cell, the context now comes into existence at the first
 * `setupGlyph` — so "no context yet" is the normal state at a fresh mount, and again after every
 * font change (the layer disposes the context BEFORE it bumps the generation). A caller reading
 * that as "not shared" would hand every terminal on the canvas a budget client moments before
 * they all attach grids: the both-renderers hazard. Nor may such a caller build one to find out —
 * at the font-change bump xterm has not re-measured its cell yet, so a context created there
 * would rasterize its atlas at the OLD cell while every grid registers against the new one.
 *
 * False therefore means only: the mode is off, the session has failed, or this machine has
 * already proved it cannot build a context (`creationAttempted` with nothing live — a flag every
 * disposal resets, so a font change never looks like a failure).
 */
export function sharedGlyphAvailable(): boolean {
  if (!sharedGlyphActive()) return false
  return live !== null || !creationAttempted
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
 * **The rule is plain ARRAY order, and nothing else.** It used to mirror React Flow's
 * `elevateNodesOnSelect` by sorting selected nodes last, because that prop (on by default) lifts a
 * selected node's DOM z-index to 1000 wherever it sits in the array. Mirroring it fixed one half of
 * the overlap and created the other: the shared canvas paints in ONE global order, so with the
 * selected node's grid on top, its text correctly occluded the neighbour's text — while the
 * neighbour's opaque DOM chrome still sat over the selected node's TRANSPARENT body. The user saw
 * crisp chrome from one node and the other node's text through it, in the same rectangle. There is
 * no ordering of the grids that fixes that, because canvas text can never paint over DOM chrome.
 *
 * The fix is upstream: while the shared layer is active Canvas passes `elevateNodesOnSelect={false}`
 * so the DOM follows the array too, and both worlds agree that "later in the array is on top". The
 * elevation this function existed to mirror no longer happens in the only mode that reads this
 * signature, so the selection-awareness is gone with it — see the invariant at that prop.
 */
// `selected` is still in the accepted shape and deliberately unread: it says out loud that the
// signature SEES the selection and chooses to ignore it, which is the thing a future reader is
// most likely to try to "fix" back.
export function nodeOrderSig(
  nodes: readonly { id: string; type?: string; selected?: boolean }[]
): string {
  let sig = ''
  for (const n of nodes) {
    if (n.type !== 'terminal') continue
    sig = sig === '' ? n.id : sig + ORDER_SEP + n.id
  }
  return sig
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

/** Sanity-check the cell a caller supplies before it becomes the atlas's fixed geometry. Null =
 *  "do not build a context from this" — the caller stays on the DOM renderer, which is always a
 *  correct outcome. */
function usableCell(cell: DeviceCell | undefined): DeviceCell | null {
  if (!cell) return null
  const { cellW, cellH } = cell
  if (!Number.isFinite(cellW) || !Number.isFinite(cellH)) return null
  if (cellW <= 0 || cellH <= 0) return null
  return { cellW: Math.min(cellW, MAX_CELL_PX), cellH: Math.min(cellH, MAX_CELL_PX) }
}

function createContext(cell: DeviceCell): LiveContext | null {
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
  const { cellW, cellH } = cell
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
  cellMismatchWarned = false
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

/** Fires when a context has just been BUILT. The component listens so it can mount the fresh
 *  canvas: creation is now driven by the first terminal that offers a device cell, which can
 *  happen after the layer's own effect has already run and found nothing. Deliberately NOT a
 *  generation bump — that notification is a re-evaluate-your-participation signal to every
 *  registered terminal, and raising it from INSIDE the call one of them is making would re-enter
 *  `setupGlyph` before it has registered its grid. */
const contextListeners = new Set<() => void>()

export function subscribeSharedGlyphContext(fn: () => void): () => void {
  contextListeners.add(fn)
  return () => {
    contextListeners.delete(fn)
  }
}

/** One line per context lifetime: every terminal supplies its own device cell and they are all
 *  supposed to agree (the font settings are global). A disagreement is a real defect — a dpr
 *  change under a live context, a per-terminal letterSpacing — and the symptom is soft text, so
 *  say so rather than silently rescaling. */
let cellMismatchWarned = false
function warnOnCellDrift(ctx: LiveContext, cell: DeviceCell | null): void {
  if (!cell || cellMismatchWarned) return
  if (Math.abs(ctx.atlas.cellW - cell.cellW) < 0.01 && Math.abs(ctx.atlas.cellH - cell.cellH) < 0.01)
    return
  cellMismatchWarned = true
  console.warn(
    `[glyphgrid] atlas cell ${ctx.atlas.cellW}×${ctx.atlas.cellH} does not match this terminal's ` +
      `device cell ${cell.cellW}×${cell.cellH} — its glyphs will be resampled`
  )
}

/**
 * The singleton, created on first use. Internal because it also exposes the canvas + GL, which
 * only this file's component may touch.
 *
 * Creation needs `cell` — xterm's device cell (see `DeviceCell`) — so a caller that has no
 * terminal to ask (the component itself) gets the EXISTING context or null, and never builds one
 * with guessed metrics. The first caller that does have one fixes the atlas geometry for the life
 * of the context; a font change tears it down and the next caller rebuilds it with the new cell.
 */
function ensureLiveContext(cell?: DeviceCell): LiveContext | null {
  if (!sharedGlyphActive()) return null
  if (live) {
    warnOnCellDrift(live, usableCell(cell))
    return live
  }
  const seed = usableCell(cell)
  if (!seed) return null
  if (creationAttempted) return null
  creationAttempted = true
  ensureSettingsSubscription()
  // Construction is guarded, and deliberately does NOT go through `failSharedGlyph`: a THROW here
  // (an OffscreenCanvas/2d-context/WebGL constructor that raises instead of returning null on a
  // hostile or exhausted GPU stack) must degrade EXACTLY like the null-returning paths inside
  // `createContext` — return null, the caller stays on the DOM renderer. Setting `failed` would
  // additionally bump the generation and re-notify every registrant from inside a call one of
  // them is already making, and it would mark the whole session dead for a condition the
  // null paths treat as "not available here". `creationAttempted` is already true, so the throw
  // is never retried in a loop.
  try {
    live = createContext(seed)
  } catch (err) {
    console.warn('[glyphgrid] shared context construction threw; staying on the DOM renderer', err)
    live = null
  }
  // Announced only on success, and AFTER `live` is set, so a listener that immediately asks for
  // the context finds it.
  if (live) for (const fn of contextListeners) fn()
  return live
}

/**
 * The shared engine + atlas, created on first use. Null means "stay on the DOM renderer": the
 * mode is off, the session has failed, this machine has no WebGL2/OffscreenCanvas — or no context
 * exists yet and the caller passed no `deviceCell` to build one from.
 *
 * `deviceCell` is xterm's `dimensions.device.cell` for the asking terminal. It is what the atlas
 * rasterizes into, and the invariant it exists for is on `DeviceCell`: **the atlas texel grid is
 * xterm's device cell grid, always.**
 */
export function getSharedGlyphContext(deviceCell?: DeviceCell): SharedGlyphContext | null {
  return ensureLiveContext(deviceCell)
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
  /** Bumped when a terminal BUILDS the context. The layer cannot build one itself — the atlas
   *  geometry comes from a live terminal's device cell (see `DeviceCell`) — so whichever of the
   *  two runs first, the canvas still gets mounted: if this effect ran first it found nothing and
   *  this tick brings it back. Declared BEFORE the mounting effect so the subscription is live by
   *  the time a terminal in the same commit can create one. */
  const [contextTick, setContextTick] = useState(0)
  useEffect(() => subscribeSharedGlyphContext(() => setContextTick((n) => n + 1)), [])

  useEffect(() => {
    const host = hostRef.current
    if (!host || failed) return
    // No cell argument: the component never CREATES a context, it only adopts one.
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
  }, [generation, failed, contextTick])

  return (
    <div
      ref={hostRef}
      className="glyphgrid-layer"
      style={{ position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' }}
    />
  )
}
