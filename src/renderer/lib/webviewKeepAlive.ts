/**
 * Background keep-alive for webview-hosting nodes (browser/web) across project switches —
 * issue #301's "browser nodes reload their page on every tab change".
 *
 * WHY THIS SHAPE. An Electron `<webview>`'s guest process dies the moment its element leaves the
 * DOM, and — measured on Electron 42.x — it ALSO dies on a DOM *move* (`insertBefore` into a new
 * or even the same parent detaches first), while it survives, state intact, any amount of sibling
 * churn around it and `display:none` of itself or an ancestor (the guest keeps its viewport size
 * and scroll while hidden, repaints pixel-identically on reveal, and its timers keep running,
 * throttled like a background tab). So a page survives a project switch if and only if its
 * `<webview>` element is NEVER unmounted and NEVER reordered relative to the other kept elements —
 * React only calls `insertBefore` on a kept child when its relative order among kept children
 * changes (the `lastPlacedIndex` rule), and that one call is the guest's death.
 *
 * Hence the design: every webview-hosting node renders in ONE stable region at the END of the
 * `<ReactFlow>` nodes prop — the "pool region" — whose internal order is owned by the pool entries
 * here and never changes while an entry lives. The active project's entries render as the live
 * nodes; a background project's render as GHOSTS: same node id (React key stability is the whole
 * point), `display:none`, non-interactive, position parked at the origin. Merging happens at the
 * prop, exactly like the ephemeral subagent cards — Canvas state, persistence, undo and the wire
 * never see a ghost.
 *
 * The invariant every function here preserves, and the one a refactor must not break: **the
 * relative order of surviving entries is identical in consecutive merge outputs.** Appends and
 * removals are fine; a reorder kills a live page. `orderIsStable` in the tests states it directly.
 *
 * Memory bounds (same posture as the park/WebGL budgets — a lever must not end live work):
 *  - the Browser Memory Saver already discards any HIDDEN webview after `BROWSER_DISCARD_MS`
 *    unless it is loading/audible/agent-driven, and a ghost is hidden by construction — the
 *    existing per-surface hook reaps it, and `onGuestDiscarded` then drops the entry (the husk
 *    would otherwise hold a cap slot for a guest that no longer exists);
 *  - `BACKGROUND_WEBVIEW_MAX` hard-caps how many background guests exist at once, evicting the
 *    longest-retired first, for the user who switches through many projects faster than the
 *    saver's window (or who turned the saver off).
 */
import type { CanvasNode } from '../state/workspace'
import type { NodeKind } from '@shared/types'

/** Node kinds that host an Electron `<webview>` (a whole Chromium renderer process). */
export const KEEPALIVE_KINDS: ReadonlySet<string> = new Set(['browser', 'web'])

/**
 * Hard cap on simultaneously-alive BACKGROUND guests. Each one is a Chromium renderer
 * (~50–200 MB); the Browser Memory Saver reaps hidden ones after its window, so this cap only
 * bites a fast multi-project switcher — and then evicts the longest-retired page, which is also
 * the one whose in-page state was most likely stale anyway.
 */
export const BACKGROUND_WEBVIEW_MAX = 8

/** One pooled webview node. Immutable — every update replaces the entry object, which is what
 *  lets the merge cache ghost node objects by entry identity. */
export interface KeepAliveEntry {
  nodeId: string
  projectId: string
  /** Snapshot of the node as last seen live. `data` carries what the mounted surface needs to
   *  keep rendering consistently (url/title/partition/filePath…). */
  node: { type: NodeKind; width?: number; height?: number; data: CanvasNode['data'] }
  /** When this entry went to the background (ms epoch) — LRU key for the cap. 0 = active. */
  retiredAt: number
}

/** Does this live flow node belong in the pool region at all? */
export function isKeepAliveKind(n: { type?: string }): boolean {
  return !!n.type && KEEPALIVE_KINDS.has(n.type)
}

/** Does this node hold a guest worth keeping alive in the background? A start-page browser or an
 *  empty web node has no guest process — retiring it would keep a husk for nothing. */
export function hasKeepAliveContent(n: { data?: { url?: unknown; filePath?: unknown } }): boolean {
  return !!(n.data && (n.data.url || n.data.filePath))
}

/** Ghost node objects cached by entry identity, so a drag frame's merge re-emits the SAME object
 *  and React Flow / React bail out instead of re-rendering every ghost per frame. */
const ghostCache = new WeakMap<KeepAliveEntry, CanvasNode>()

/**
 * The React Flow node a background entry renders as. Same id (key stability), `display:none`
 * (guest survives, IntersectionObserver reads it as hidden so the memory saver's clock runs),
 * non-interactive on every axis, `parentId`-free and parked at the origin — a hidden node has no
 * geometry, so its position only matters for not skewing minimap/fit bounds.
 */
export function ghostFlowNode(entry: KeepAliveEntry): CanvasNode {
  const cached = ghostCache.get(entry)
  if (cached) return cached
  const node: CanvasNode = {
    id: entry.nodeId,
    type: entry.node.type,
    position: { x: 0, y: 0 },
    width: entry.node.width,
    height: entry.node.height,
    data: { ...entry.node.data, ghost: true },
    style: { display: 'none' },
    draggable: false,
    selectable: false,
    deletable: false,
    connectable: false,
    focusable: false
  }
  ghostCache.set(entry, node)
  return node
}

/**
 * Build the `<ReactFlow>` nodes prop: non-webview live nodes, then the ephemeral cards, then the
 * pool region — every pool entry in pool order (live object for the MOUNTED project, ghost for
 * any other), then any mounted webview node the pool does not know yet (a node created since the
 * last switch), in live array order.
 *
 * `mountedProjectId` is the project `liveNodes` actually BELONGS to (Canvas's
 * `keepAliveFromRef`), and deliberately NOT the active-project id. The two disagree for exactly
 * one commit per switch — the tab click re-renders with the new active id while the load effect
 * has not yet swapped the node array — and pairing entries against the active id there made a
 * returning entry take the live branch, miss its node in the not-yet-swapped array, and drop out
 * of the merged list for that commit: one unmount, guest dead, page reloaded — the precise
 * failure this module exists to prevent ([MEASURED] in the app: ghost→live remounted the wrapper
 * while live→ghost, which has no such window, kept it). Keyed on the mounted project, that
 * commit's output is id-identical to the previous one, and the whole swap lands in the single
 * commit the load effect produces.
 *
 * Hoisting the ACTIVE webview nodes to the tail region is what keeps their DOM position stable
 * across the active↔ghost transitions; the visible cost is a tie-break change — an unselected
 * webview node now paints above other unselected z-0 nodes it overlaps, instead of by creation
 * order. Selection elevation (z 1000) still wins, so anything being dragged or selected stays on
 * top of a page.
 */
export function mergeWithKeepAlive(
  liveNodes: readonly CanvasNode[],
  ephemeralNodes: readonly CanvasNode[],
  entries: readonly KeepAliveEntry[],
  mountedProjectId: string | null
): CanvasNode[] {
  const anyPool = entries.length > 0 || liveNodes.some(isKeepAliveKind)
  if (!anyPool) {
    // No webview node anywhere: hand back the live array ITSELF (React Flow's array-identity
    // short-circuit), byte-identical to the pre-pool merge.
    return ephemeralNodes.length ? [...liveNodes, ...ephemeralNodes] : (liveNodes as CanvasNode[])
  }
  const byId = new Map<string, CanvasNode>()
  for (const n of liveNodes) if (isKeepAliveKind(n)) byId.set(n.id, n)
  const out: CanvasNode[] = []
  for (const n of liveNodes) if (!isKeepAliveKind(n)) out.push(n)
  out.push(...ephemeralNodes)
  const seen = new Set<string>()
  for (const e of entries) {
    seen.add(e.nodeId)
    if (e.projectId === mountedProjectId) {
      // Live object, not the snapshot: position/selection/data flow straight through.
      //
      // A miss FALLS BACK TO THE GHOST rather than dropping the entry from the output. The pool
      // store, `keepAliveFromRef` and `nodes` are three state sources that do not all land in the
      // same commit (zustand rides useSyncExternalStore; `setNodes` is ordinary state), so a
      // switch can render one commit where the entries already say "mounted" while the node array
      // is still the outgoing project's — and an id absent from ONE commit is an unmount, i.e. a
      // dead guest and a page reload ([MEASURED] in the app: this exact interleaving remounted
      // every returning page; the jsdom test cannot see it because it renders atomically).
      // The fallback costs nothing when it fires wrongly for a genuinely DELETED node: the ghost
      // is invisible, and every deletion funnel drops the entry (handleNodesChange's remove
      // branch, the peer-mutation remove, project deletion), with the next retire as the backstop.
      const live = byId.get(e.nodeId)
      out.push(live ?? ghostFlowNode(e))
    } else {
      out.push(ghostFlowNode(e))
    }
  }
  for (const n of liveNodes) {
    if (isKeepAliveKind(n) && !seen.has(n.id)) out.push(n)
  }
  return out
}

/** The node ids currently rendered as GHOSTS (background entries) — the set `handleNodesChange`
 *  drops on the floor: nothing about a background node is a canvas edit. */
export function backgroundNodeIds(
  entries: readonly KeepAliveEntry[],
  activeProjectId: string | null
): Set<string> {
  const out = new Set<string>()
  for (const e of entries) if (e.projectId !== activeProjectId) out.add(e.nodeId)
  return out
}

/**
 * Retire a project's webview nodes into the pool: upsert a fresh snapshot for every content-bearing
 * webview node (keeping an existing entry's ORDER SLOT — the invariant), prune the project's
 * entries whose node is gone (deleted, or its content cleared), and evict the longest-retired
 * background entries beyond the cap. Pure; the store owns the state.
 */
export function retireIntoPool(
  entries: readonly KeepAliveEntry[],
  projectId: string,
  outgoingNodes: readonly CanvasNode[],
  now: number,
  cap: number = BACKGROUND_WEBVIEW_MAX
): KeepAliveEntry[] {
  const keep = new Map<string, CanvasNode>()
  for (const n of outgoingNodes) {
    if (isKeepAliveKind(n) && hasKeepAliveContent(n)) keep.set(n.id, n)
  }
  const snapshot = (n: CanvasNode, prior?: KeepAliveEntry): KeepAliveEntry => ({
    nodeId: n.id,
    projectId,
    node: {
      type: n.type as NodeKind,
      width: n.width ?? n.measured?.width ?? undefined,
      height: n.height ?? n.measured?.height ?? undefined,
      // The ghost must render with the values the mounted surface last reported, or the props
      // transition at the switch would navigate the live page (BrowserSurface reloads when its
      // `url` prop moves away from where it is).
      data: { ...n.data }
    },
    // A re-retired entry keeps its original clock only if it was already background (it cannot
    // be: retire runs on the project we are LEAVING, whose entries were active). Fresh clock.
    retiredAt: prior && prior.projectId === projectId && prior.retiredAt ? prior.retiredAt : now
  })
  const next: KeepAliveEntry[] = []
  for (const e of entries) {
    if (e.projectId !== projectId) {
      next.push(e)
      continue
    }
    const live = keep.get(e.nodeId)
    if (!live) continue // node deleted or content gone — entry ends, ghost unmounts
    keep.delete(e.nodeId)
    next.push(snapshot(live, e))
  }
  // Nodes the pool has not seen yet, appended in live array order (their merge position was
  // already "after every entry", so appending preserves each element's relative order).
  for (const n of outgoingNodes) {
    if (keep.has(n.id)) next.push(snapshot(n))
  }
  return evictOverCap(next, cap)
}

/**
 * Mark a project's entries ACTIVE (retiredAt 0). Runs on the way INTO a project, and must run
 * BEFORE the outgoing project's `retireIntoPool` — an incoming entry still carrying its old
 * background clock would be the cap's oldest candidate at the exact moment its page is about to
 * be revealed, and evicting it there would reload the very page the pool preserved.
 */
export function activateInPool(
  entries: readonly KeepAliveEntry[],
  projectId: string
): KeepAliveEntry[] {
  return entries.map((e) => (e.projectId === projectId && e.retiredAt !== 0 ? { ...e, retiredAt: 0 } : e))
}

/** Drop the longest-retired background entries beyond `cap`. Removal never reorders survivors. */
export function evictOverCap(entries: readonly KeepAliveEntry[], cap: number): KeepAliveEntry[] {
  const background = entries.filter((e) => e.retiredAt > 0)
  if (background.length <= cap) return [...entries]
  const evict = new Set(
    background
      .slice()
      .sort((a, b) => a.retiredAt - b.retiredAt)
      .slice(0, background.length - cap)
      .map((e) => e.nodeId)
  )
  return entries.filter((e) => !evict.has(e.nodeId))
}

/**
 * Overlay a returning project's pool data onto its freshly deserialized flow nodes, BEFORE the
 * single `setNodes` — a page that navigated while it was a ghost must come back with `data.url`
 * already at its live location, or the props transition (persisted, stale url) would navigate the
 * surviving webview backwards. Only url/title move; everything else is the file's business.
 */
export function overlayKeepAliveData(
  flow: readonly CanvasNode[],
  entries: readonly KeepAliveEntry[],
  projectId: string
): CanvasNode[] {
  const byId = new Map<string, KeepAliveEntry>()
  for (const e of entries) if (e.projectId === projectId) byId.set(e.nodeId, e)
  if (byId.size === 0) return [...flow]
  return flow.map((n) => {
    const e = byId.get(n.id)
    if (!e) return n
    const url = e.node.data.url
    const title = e.node.data.title
    if ((url === undefined || url === n.data.url) && (title === undefined || title === n.data.title))
      return n
    return {
      ...n,
      data: {
        ...n.data,
        ...(url !== undefined ? { url } : {}),
        ...(title !== undefined ? { title } : {})
      }
    }
  })
}
