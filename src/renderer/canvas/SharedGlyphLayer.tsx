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
 *    failure), `setNodeZOrder`/`nodeZFor`/`subscribeNodeZOrder` (paint order),
 *    `setOpaqueNodeIds`/`nodeIsOpaque`/`subscribeOpaqueSet` (which terminals must leave the shared
 *    canvas — see the stacking rule above that set), and `setSharedGlyphCamera` (pan/zoom). Every
 *    one of them is a no-op while no context exists, so Canvas can call them unconditionally and a
 *    default-mode user pays a null check.
 *
 * The component and the GL singleton have NO unit tests by design — there is no WebGL2, no
 * OffscreenCanvas and no layout in vitest's node environment. The pure parts (order signature,
 * store transitions, z map) are tested; the rest is on the T6 device checklist. That split is the
 * same one `terminal/glyphgrid-attach.ts` makes for xterm's internals.
 */

import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import {
  GUTTER_PX,
  GlyphAtlas,
  type GlyphAtlasSubscription,
  type GlyphSlotAllocation
} from '../glyphgrid/atlas'
import type { Camera } from '../glyphgrid/camera'
import { GlyphGridEngine } from '../glyphgrid/engine'
import type { GlyphGL } from '../glyphgrid/gl'
import { createWebgl2GL } from '../glyphgrid/gl-webgl2'
import { createCanvasRasterizer } from '../glyphgrid/raster'
import { useSettings } from '../state/settings'

/** Atlas page edge, in DEVICE pixels. 2048 (not Phase 0's 1024) because the atlas cells are
 *  device-sized AND the page is now keyed by COLOUR: at dpr 2 a 13px terminal font is roughly a
 *  16x32 device cell, which on a 2048 page (slot pitch = the cell plus a gutter each side) leaves
 *  room for a few thousand `(code, style, fg, bg)` slots. Under the old monochrome keying that was
 *  a whole session's glyph REPERTOIRE; under colour keying the same repertoire costs one slot per
 *  colour pair it is ever drawn in, so the page is a working set rather than a cache of everything.
 *
 *  Which is why filling it is a NORMAL event, not a failure: `GlyphAtlas` answers a full page by
 *  clearing it and telling every addon to repack (see its `reset`), so the cost is one expensive
 *  frame instead of the missing text an earlier version of this comment described. Sizing the page
 *  generously is therefore about keeping resets RARE (they are logged — see `installAtlasResetLog`),
 *  not about never reaching the end of it.
 *
 *  2048² RGBA = 16 MB, plus the mip chain the minification filter needs — clamped to MAX_SAFE_LOD,
 *  so levels 1 and 2 only, about 5 MB more. ~21 MB of VRAM, once, for the whole canvas. */
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

/** React Flow's selection elevation (`@xyflow/system`'s `SELECTED_NODE_Z`). Copied rather than
 *  imported because it is not exported; pinned by `nodeStackZ`'s tests. */
const SELECTED_NODE_Z = 1000

/** The node fields the stacking model reads. */
export interface StackOrderNode {
  id: string
  parentId?: string
  selected?: boolean
}

/**
 * REPRODUCTION of the z React Flow assigns each node, for this app's configuration: no explicit
 * `zIndex` anywhere, `elevateNodesOnSelect` at its default (on), and — the detail that decides
 * everything below — **`zIndexMode` at its default, which is `'basic'`, not `'auto'`**. Nothing in
 * `src/` passes the prop, and `@xyflow/react` 12.11 defaults it to `'basic'` in both
 * `getInitialState` and the `<ReactFlow>` component. The whole rule is then two lines of
 * `calculateZ` / `calculateChildXYZ`:
 *
 *  - Every node is `selected ? 1000 : 0`.
 *  - A CHILD is then `parentZ >= childZ ? parentZ + 1 : childZ`, its parent resolved first (React
 *    Flow requires parents before children in the array, which `nodeStatesToFlow` guarantees).
 *
 * What that means on this canvas: a group FRAME is z 0, tied with every ungrouped node — so array
 * order decides between them, and since frames sort FIRST, an ungrouped terminal overlapping a
 * populated frame paints ON TOP of it. A frame's child is 1, above both. A selected frame is 1000
 * and carries its children to 1001, above a selected ungrouped node at 1000. Nested frames stack
 * 0 / 1 / 2.
 *
 * **Two wrong models have been shipped here; both are worth naming.** Round 5's first cut modelled
 * selection only, which put a grouped terminal BELOW an ungrouped one it is in fact above. Its
 * replacement transcribed the `'auto'` branch, complete with the `ROOT_PARENT_Z_INCREMENT` banding
 * that gives a populated frame z 10 — which is gated on `zIndexMode === 'auto'` and therefore never
 * runs here. That one said an ungrouped terminal sitting on a frame was BELOW the frame, so the
 * terminal stayed transparent and the frame's border and label pill showed through it: exactly the
 * ghost this round exists to delete. The lesson is in the verification, not the reading — the model
 * is now checked against the real `adoptUserNodes`, and the tests state the numbers it returns.
 *
 * With the banding gone the model carries no order-dependent state, which also removes the
 * `checkEquality` caveat this comment used to carry: z depends only on `selected` and the parent
 * chain, React Flow recomputes every CHILD on each adopt regardless of reuse, and a reused ROOT's
 * z was computed from an identical node object. The model is exact, not approximate.
 */
export function nodeStackZ(nodes: readonly StackOrderNode[]): Map<string, number> {
  const z = new Map<string, number>()
  const byId = new Map<string, StackOrderNode>()
  for (const n of nodes) byId.set(n.id, n)
  for (const node of nodes) {
    const ownZ = node.selected ? SELECTED_NODE_Z : 0
    z.set(node.id, ownZ)
    if (!node.parentId) continue
    const parent = byId.get(node.parentId)
    // React Flow warns and gives up on a child whose parent is missing or comes LATER in the
    // array; `nodeStatesToFlow` sorts parents first precisely so this cannot happen.
    if (!parent || !z.has(parent.id)) continue
    const parentZ = z.get(parent.id) ?? 0
    z.set(node.id, parentZ >= ownZ ? parentZ + 1 : ownZ)
  }
  return z
}

/**
 * The order React Flow actually PAINTS the nodes in: ascending `nodeStackZ`, ties broken by array
 * order (a stable sort). Later in this list = nearer the viewer.
 *
 * ONE function, because two consumers must never disagree about it: `nodeOrderSig` (the grids' z)
 * and `opaqueNodeIds` (which terminals may stay on the shared canvas at all). If the opaque set
 * were derived from a different order than the z, a terminal could be told it is in the clear by
 * one rule and painted underneath by the other — the mixed-order soup of round 4, reintroduced one
 * level down.
 */
export function effectiveStackOrder<T extends StackOrderNode>(nodes: readonly T[]): readonly T[] {
  const z = nodeStackZ(nodes)
  let ordered = false
  for (const n of nodes) {
    if (z.get(n.id) !== 0) {
      ordered = true
      break
    }
  }
  // Every z is 0 — no selection and no group frame with children anywhere — so the array is already
  // in paint order and the input is returned rather than an identical copy. Worth having (a canvas
  // with no groups and nothing selected is a real state, and this runs on every nodes change) but
  // NOT the common case it was once described as: one populated group frame gives its children z 1
  // and puts every nodes change through the sort.
  if (!ordered) return nodes
  return nodes
    .map((n, i) => ({ n, i, z: z.get(n.id) ?? 0 }))
    .sort((a, b) => a.z - b.z || a.i - b.i)
    .map((e) => e.n)
}

/**
 * The paint order of the TERMINAL nodes, as one string. Canvas recomputes it per nodes change and
 * only pushes when it differs — a string compare instead of an array diff, the same trick the
 * data-signature effect next to it uses.
 *
 * Only terminals: they are the only kind that registers a grid, and mixing other kinds in would
 * churn the signature on every sticky edit.
 *
 * **The rule is `effectiveStackOrder`** — React Flow's own z (selection elevation and the
 * frame-child lift; see `nodeStackZ`), ties broken by array order. The canvas z among the glyph
 * grids mirrors the DOM's, so both worlds tell the same story about who is on top.
 *
 * Round 4 removed the mirroring and turned the PROP off instead. That was the wrong end of the
 * problem: it did make the two orders agree, but at the cost of "click/drag brings a node to the
 * front", which the user rejected outright. Round 5 fixes the overlap where it actually lives —
 * a terminal whose transparent body could reveal a node BENEATH it leaves the shared canvas and
 * paints itself on its own DOM renderer (`opaqueNodeIds` below). With every overlapping-top
 * terminal off the canvas, no two grids can be in the configuration this signature used to be
 * blamed for, so mirroring the elevation is free again.
 *
 * It matters mainly for TRANSIENT states — the frames between an overlap starting and the opaque
 * set being recomputed, and the frames after it clears — since a terminal that is durably stacked
 * over something is on the DOM renderer and owns no grid at all. Those are precisely the frames in
 * which a wrong z is visible, which is why the mirroring is worth its handful of lines.
 */
export function nodeOrderSig(
  nodes: readonly (StackOrderNode & { type?: string })[]
): string {
  let sig = ''
  for (const n of effectiveStackOrder(nodes)) {
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
// The opaque set — "glyph in the open, DOM when stacked"
// ---------------------------------------------------------------------------------------------

/**
 * THE STACKING RULE OF THE SHARED RENDERER, and the thing to read before touching any of this.
 *
 * A shared-mode terminal is a TRANSPARENT WINDOW: its body has no background, its text lives on
 * the one canvas that sits UNDER the whole node layer, and the only thing it puts between itself
 * and whatever is behind it is its grid's opaque plate — which is also on that canvas, i.e. also
 * under every node's DOM chrome. So a glyph terminal cannot occlude a node beneath it the way an
 * ordinary node does. It can hide the node's canvas TEXT (plate over plate) but never its chrome:
 * the border, the header seam, a label pill all paint straight through.
 *
 * There is no z-ordering that fixes that, in either world — one canvas cannot interleave itself
 * with per-node DOM stacking. Round 4 tried to make the two orders agree by taking selection
 * elevation away; that removed "click/drag brings it to the front", which is not negotiable.
 *
 * Round 5's rule instead: **a terminal renders through the shared canvas only while it is in the
 * open.** The moment its body could reveal something underneath, it drops the grid and goes back
 * to xterm's own DOM renderer — opaque body, native stacking, total occlusion. Concretely a
 * terminal is OPAQUE (DOM) when either holds:
 *
 *  a) its rect intersects the rect of ANY node — of any kind — that is BELOW it in the effective
 *     paint order (`effectiveStackOrder`), or
 *  b) it is in a GESTURE: it, or a group frame containing it, is being dragged or resized. A
 *     gesture is "about to be above things", and holding the node opaque for its whole duration is
 *     also what lets the rect sweep be frozen while `nodes` churns per frame. This set carries the
 *     answer (`gestureTerminalIds`, which is the only thing that can see the children of a dragged
 *     FRAME); TerminalNode additionally reads its own `dragging` prop, which flips synchronously
 *     and needs nobody — two sources for one state, deliberately, and documented at both.
 *
 * A terminal that is only UNDERNEATH others stays on the canvas: the opaque node above it hides it
 * natively, which is the case this whole design leans on. The cost is that a stacked terminal is
 * rendered by the DOM renderer for as long as it is stacked — its text is very slightly softer at
 * zoom ≠ 1 than its neighbours', which is the expected tell, not a defect.
 *
 * Two deliberate exclusions from "below it":
 *  - **A node's own ANCESTOR chain.** Every grouped terminal sits inside its group frame's rect by
 *    construction; counting that as an overlap would put every grouped terminal on the DOM
 *    renderer forever, which would gut the feature on the canvases most likely to use it.
 *  - **Nodes with unknowable geometry** (no `measured`, no `width`/`height` — the tick before
 *    React Flow has measured a fresh node). They contribute nothing in either direction, and the
 *    measurement lands as an ordinary nodes change that recomputes the set.
 *
 * TWO KNOWN GAPS, stated rather than papered over — a device tester must not file either as a bug:
 *  - The EPHEMERAL subagent/loop cards are merged into React Flow at the `<ReactFlow>` prop and are
 *    not in Canvas's `nodes` array, so they are invisible to this rule. A card can therefore sit
 *    over a glyph terminal and be visible through its body. They are display-only, they live for
 *    the length of one turn, and putting them in the rule means putting them in the nodes array,
 *    which is precisely what keeps them out of persistence and undo.
 *  - The rule compares NODE RECTS, and two node-attached surfaces deliberately escape their node's
 *    rect: the 💬 comments flyout (`.term-node__comments`) and the kanban `ColumnPill`, both
 *    siblings of the overflow:hidden node root. A NEIGHBOUR's flyout or pill overhanging a glyph
 *    terminal is not seen here, so it can show through that terminal's body. Fixing it means
 *    feeding real chrome geometry into the rule — a Phase-2 question, and the same one L15's other
 *    Phase-2 answer (chrome on the canvas) settles for free.
 */

/** Node shape this derivation reads. Loose on purpose: it must accept a live measured node and a
 *  freshly deserialized one (`width`/`height`, no `measured`) alike. */
export interface StackedNode extends StackOrderNode {
  type?: string
  position: { x: number; y: number }
  width?: number | null
  height?: number | null
  measured?: { width?: number | null; height?: number | null }
  /** React Flow's own gesture flags: `dragging` during a node drag, `resizing` while a
   *  `NodeResizer` handle is held. */
  dragging?: boolean
  resizing?: boolean
  data?: { collapsed?: unknown; mdMode?: unknown }
}

interface StackRect {
  x: number
  y: number
  w: number
  h: number
}

/** A `parentId` chain longer than this is a data bug (or a cycle) — stop walking. Same constant,
 *  same reason, as `lib/nodeFocus`. */
const MAX_PARENT_DEPTH = 20

const positiveSize = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

/** The node's rect in ABSOLUTE canvas coordinates (a grouped node's `position` is relative to its
 *  frame, so the parent chain is walked), or null when its size is not knowable yet. */
function absoluteRect(node: StackedNode, byId: Map<string, StackedNode>): StackRect | null {
  const w = positiveSize(node.measured?.width) ?? positiveSize(node.width)
  const h = positiveSize(node.measured?.height) ?? positiveSize(node.height)
  if (w === null || h === null) return null
  let { x, y } = node.position
  let parentId = node.parentId
  const seen = new Set<string>([node.id])
  for (let depth = 0; parentId && depth < MAX_PARENT_DEPTH; depth++) {
    if (seen.has(parentId)) break
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentId
  }
  return { x, y, w, h }
}

/** Strictly overlapping AREA. Edge-to-edge nodes (a snapped grid, a tidy row) share a boundary and
 *  nothing else — treating that as an overlap would send half a neat canvas to the DOM renderer. */
function rectsOverlap(a: StackRect, b: StackRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Whether `ancestorId` is on `node`'s parent chain — see the exclusion note above. */
function isAncestorOf(node: StackedNode, ancestorId: string, byId: Map<string, StackedNode>): boolean {
  let parentId = node.parentId
  const seen = new Set<string>([node.id])
  for (let depth = 0; parentId && depth < MAX_PARENT_DEPTH; depth++) {
    if (parentId === ancestorId) return true
    if (seen.has(parentId)) return false
    seen.add(parentId)
    parentId = byId.get(parentId)?.parentId
  }
  return false
}

/**
 * The terminals that must render on their OWN (opaque, DOM) renderer right now, by the rule
 * documented above. Pure — Canvas owns WHEN to run it (see the settle gate there), this owns what
 * the answer is.
 *
 * Collapsed / ⌘M terminals are left out: they hold no grid either way, so naming them here would
 * only churn the pushed signature. They still count as nodes something else can be stacked over —
 * a collapsed terminal is an opaque header strip, and covering one is a real overlap.
 */
export function opaqueNodeIds(nodes: readonly StackedNode[]): string[] {
  const order = effectiveStackOrder(nodes)
  const byId = new Map<string, StackedNode>()
  for (const n of nodes) byId.set(n.id, n)
  const rects = order.map((n) => absoluteRect(n, byId))
  const out: string[] = []
  for (let i = 0; i < order.length; i++) {
    const node = order[i]
    if (node.type !== 'terminal') continue
    if (node.data?.collapsed || node.data?.mdMode) continue
    const rect = rects[i]
    if (!rect) continue
    for (let j = 0; j < i; j++) {
      const below = rects[j]
      if (!below || !rectsOverlap(rect, below)) continue
      if (isAncestorOf(node, order[j].id, byId)) continue
      out.push(node.id)
      break
    }
  }
  return out
}

/**
 * Is a node GESTURE (drag or `NodeResizer` resize) in progress anywhere on the canvas? While one
 * is, the O(n²) rect sweep above is skipped: `nodes` is rebuilt every frame of a gesture, and
 * recomputing there would flip a terminal's neighbours between the two renderers at 60 Hz — each
 * flip is a real xterm renderer swap. The frozen set is topped up with `gestureTerminalIds`.
 */
export function hasActiveGesture(nodes: readonly StackedNode[]): boolean {
  for (const n of nodes) if (n.dragging || n.resizing) return true
  return false
}

/**
 * The terminals that must be opaque BECAUSE OF a gesture: their own node is being dragged/resized,
 * or an ANCESTOR is.
 *
 * The ancestor half is not a nicety. React Flow's `getDragItems` excludes the children of a dragged
 * parent (the frame moves, the children ride along on `positionAbsolute`), so dragging a GROUP
 * never sets `dragging` on the terminals inside it. Without this walk those terminals stayed
 * transparent for the whole gesture while the frame swept them across the canvas — the worst case
 * of the bug this design exists to fix, and the one case the per-node `dragging` prop cannot see.
 *
 * The dragged node itself is included even though TerminalNode also reads its own `dragging` prop:
 * one answer, from one place, for a state two consumers act on.
 */
export function gestureTerminalIds(nodes: readonly StackedNode[]): string[] {
  const byId = new Map<string, StackedNode>()
  for (const n of nodes) byId.set(n.id, n)
  const out: string[] = []
  for (const node of nodes) {
    if (node.type !== 'terminal') continue
    let cur: StackedNode | undefined = node
    const seen = new Set<string>()
    for (let depth = 0; cur && depth <= MAX_PARENT_DEPTH; depth++) {
      if (cur.dragging || cur.resizing) {
        out.push(node.id)
        break
      }
      if (seen.has(cur.id)) break
      seen.add(cur.id)
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
  }
  return out
}

let opaqueIds = new Set<string>()
let opaqueSig = ''
let opaquePending = false
const opaqueListeners = new Set<() => void>()

/**
 * Store the opaque set WITHOUT notifying, returning the signature. Change-gated on a SORTED
 * signature — this is a set, not a sequence, so the same membership arriving in a different order
 * (a node reorder that changes nothing about who overlaps whom) must not wake every terminal.
 *
 * **The split from `flushOpaqueNodeIds` is the ordering fix, and it is the point of this seam.**
 * Canvas computes the set DURING ITS RENDER, because React renders a parent before its children:
 * that is the only moment at which a TerminalNode can read the answer for the same `nodes` array
 * it is itself rendering with. Computing it in an effect cannot work — effects run CHILD FIRST, so
 * on the commit that ends a drag the node's participation effect re-attached a glyph against the
 * PREVIOUS set, and the parent's effect then told it to tear the glyph down again: one frame of a
 * transparent node sitting over the thing it had just been dropped on, plus a wasted attach/detach
 * pair. The same window opened on create-into-overlap and on project-load-with-overlaps.
 *
 * Notifying cannot happen there, though: a listener's `setState` during another component's render
 * is exactly what React refuses. So the write and the notification are separated — the write is
 * safe during render, and `flushOpaqueNodeIds` (an effect) delivers the notification afterwards,
 * for the one case a render-time read cannot cover: a node whose own object did not change and
 * which therefore did not re-render at all (something slid UNDER it).
 */
export function primeOpaqueNodeIds(ids: readonly string[]): string {
  const sig = [...ids].sort().join(ORDER_SEP)
  if (sig === opaqueSig) return sig
  opaqueSig = sig
  opaqueIds = new Set(ids)
  opaquePending = true
  return sig
}

/** Deliver the notification for a primed change. Idempotent — a second call with nothing pending
 *  is free, which is what lets Canvas call it from an effect keyed on the signature. */
export function flushOpaqueNodeIds(): void {
  if (!opaquePending) return
  opaquePending = false
  for (const fn of opaqueListeners) fn()
}

/** Prime + flush in one call. The imperative form, for callers that are NOT inside a render. */
export function setOpaqueNodeIds(ids: readonly string[]): void {
  primeOpaqueNodeIds(ids)
  flushOpaqueNodeIds()
}

/** Must this node paint its own pixels right now? Always false while nothing has been pushed,
 *  which is every default-mode session. Read at RENDER time by TerminalNode (see above) — never
 *  mirrored into state, which is what would make it stale. */
export function nodeIsOpaque(id: string): boolean {
  return opaqueIds.has(id)
}

/** Terminals subscribe here and re-read `nodeIsOpaque` — same lifecycle as the z subscription. */
export function subscribeOpaqueSet(fn: () => void): () => void {
  opaqueListeners.add(fn)
  return () => {
    opaqueListeners.delete(fn)
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
  /** The console reset gauge's subscription, held so teardown can drop it: the atlas dies with the
   *  context, but a subscription left on a rebuilt-and-then-disposed one would keep a closure alive
   *  per font change. */
  resetLog: GlyphAtlasSubscription
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

/**
 * TEMPORARY device-debug instrumentation for the blank-single-glyph bug (round 5's `ç`, round 7's
 * lowercase `x`: one letter renders blank while its neighbours are fine, reproducibly, for the
 * whole session). It is OFF unless `localStorage['nodeterm.glyphgridDebug'] === '1'`.
 *
 * Why instrumentation instead of a fix: every path that can blank ONE slot was audited headlessly
 * and is clean (see `GlyphSlotAllocation`). Reproducing needs a real font on a real device, so
 * rather than guess at a fifth candidate, one device round is spent turning the report into a
 * measurement. Remove this once the bug is closed.
 *
 * The dump is the load-bearing half. It answers the one question that halves the search space:
 * **is the letter missing from the ATLAS, or present in the atlas but blank on screen?**
 *  - missing in the atlas  → the rasterizer (font/baseline/clip) is the suspect;
 *  - present in the atlas  → the slot→uv mapping or the texture upload is.
 * Everything else is downstream of that answer, which is why the tester is asked for the PNG and
 * not for a longer log.
 */
function glyphDebugOn(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('nodeterm.glyphgridDebug') === '1'
  } catch {
    // Storage can throw outright (Safari private mode, a locked-down embedder). Debug off is
    // always a safe answer.
    return false
  }
}

function glyphDebugTap(): ((info: GlyphSlotAllocation) => void) | undefined {
  if (!glyphDebugOn()) return undefined
  return ({ slot, code, bold, italic, x, y, fg, bg }): void => {
    console.warn(
      `[glyphgrid] slot ${slot} code 0x${code.toString(16)} ${JSON.stringify(
        String.fromCodePoint(code)
      )}${bold ? ' bold' : ''}${italic ? ' italic' : ''} at ${x},${y} fg=${fg.toString(
        16
      )} bg=${bg.toString(16)}`
    )
  }
}

/** Exposes `window.__glyphgridDump()` → `{ page, ...geometry }`, where `page` is a PNG data URL of
 *  the whole atlas. Installed only under the debug flag; the tester opens the data URL in a tab and
 *  looks for the reported letter.
 *
 *  READING THE PNG SINCE THE ATLAS WENT COLOURED. It is no longer white ink on a black page: each
 *  slot holds the glyph in its real foreground over its real background, so a dark-theme page is
 *  mostly dark-on-dark and the whole page ground OUTSIDE the allocated slots is TRANSPARENT (it
 *  renders as the viewer's own backdrop — white in a browser tab, not black). "The letter's cell is
 *  black" is therefore no longer the test for "missing": the test is whether the cell holds an
 *  inkless expanse of its own BACKGROUND colour. The same letter can also legitimately appear MANY
 *  times, once per colour pair it has been drawn in.
 *
 *  `gutterPx` and `resetCount` ride along for that reading: a slot's ink starts one gutter inside
 *  its pitch cell (so `strideX`-based arithmetic alone lands a couple of texels off), and a page
 *  that has reset is a page whose slot numbering has been reused — a dumped slot index only means
 *  something alongside the reset count it was taken at. */
function installGlyphDump(atlas: GlyphAtlas, raster: { cellW: number; cellH: number }): void {
  if (!glyphDebugOn() || typeof window === 'undefined') return
  ;(window as unknown as Record<string, unknown>).__glyphgridDump = async (): Promise<unknown> => {
    const source = atlas.source
    const geometry = {
      pageSizePx: atlas.sizePx,
      cellW: raster.cellW,
      cellH: raster.cellH,
      strideX: atlas.strideX,
      strideY: atlas.strideY,
      gutterPx: GUTTER_PX,
      cols: Math.floor(atlas.sizePx / atlas.strideX),
      capacity: atlas.capacity,
      resetCount: atlas.resetCount
    }
    // `source` is the rasterizer's OffscreenCanvas; convertToBlob is the only way to read it back.
    if (!source || typeof (source as OffscreenCanvas).convertToBlob !== 'function')
      return { ...geometry, page: null }
    const blob = await (source as OffscreenCanvas).convertToBlob({ type: 'image/png' })
    const page = await new Promise<string>((resolve) => {
      const fr = new FileReader()
      fr.onload = (): void => resolve(String(fr.result))
      fr.readAsDataURL(blob)
    })
    return { ...geometry, page }
  }
}

/** The atlas surface the reset log reads. Structural rather than `GlyphAtlas` so the log can be
 *  exercised without a page full of real glyphs — filling a real one takes a rasterizer, which this
 *  environment does not have. */
export interface AtlasResetSource {
  resetCount: number
  onReset(cb: () => void): GlyphAtlasSubscription
}

/** Quiet period after a logged reset. */
const RESET_LOG_INTERVAL_MS = 1000

/**
 * Announce atlas page resets on the console.
 *
 * NOT gated on the debug flag, unlike the dump and the allocation tap. A reset is the v1
 * reset-on-full model's pressure gauge: it is supposed to be RARE, and the number that decides
 * whether Phase 2 has to build real LRU eviction is how often it actually happens in a day's use —
 * which nobody will have collected if seeing it required knowing to turn a flag on first. It costs a
 * console line per reset on a canvas where resets are rare, which is the case this design claims.
 *
 * THROTTLED, because the case where the claim is wrong is exactly the case that would drown in it: a
 * page too small for the canvas resets on every repack, i.e. once per frame, and an unthrottled warn
 * there is both a real frame cost and a console the tester cannot read the rest of. So at most one
 * line per `RESET_LOG_INTERVAL_MS`, carrying the count of the ones it swallowed — a burst still
 * reports as a burst, in one line instead of sixty.
 *
 * `now` is injected for the tests; production passes nothing.
 */
export function installAtlasResetLog(
  atlas: AtlasResetSource,
  now: () => number = Date.now
): GlyphAtlasSubscription {
  // -Infinity, not 0: the FIRST reset must always print, whatever the clock reads.
  let lastAt = -Infinity
  let swallowed = 0
  return atlas.onReset(() => {
    const t = now()
    if (t - lastAt < RESET_LOG_INTERVAL_MS) {
      swallowed++
      return
    }
    lastAt = t
    const extra = swallowed > 0 ? ` (+${swallowed} more since the last line)` : ''
    swallowed = 0
    console.warn(
      `[glyphgrid] atlas page reset #${atlas.resetCount} — colour key space full, every row repacks${extra}`
    )
  })
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
  const atlas = new GlyphAtlas(raster, ATLAS_PAGE_PX, glyphDebugTap())
  installGlyphDump(atlas, raster)
  const engine = new GlyphGridEngine(gl, atlas)
  engine.setCamera(lastCamera)
  return {
    engine,
    atlas,
    canvas,
    gl,
    resetLog: installAtlasResetLog(atlas),
    fontKey: fontKeyOf(fontFamily, fontSize),
    disposed: false
  }
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
    ctx.resetLog.dispose()
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
