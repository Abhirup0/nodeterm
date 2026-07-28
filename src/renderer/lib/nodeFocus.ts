import { getViewportForBounds, type Rect, type Viewport } from '@xyflow/system'

/**
 * "Zoom to this node" geometry, computed WITHOUT React Flow's measurements.
 *
 * Why this exists: `fitView({ nodes: [{ id }] })` is the natural way to frame one node, and it is
 * what `Canvas.goToNode` uses — but React Flow filters the fit set down to nodes it has already
 * MEASURED (`getFitViewNodes` keys off `measured.width && measured.height`; there is no
 * `width`/`height` fallback there). A node that was handed to React Flow a tick ago has no
 * measurement yet, so the fit set comes out EMPTY, its bounds collapse to `{0,0,0,0}` and the
 * camera flies to the canvas ORIGIN at max zoom — an empty stretch of canvas, nowhere near the
 * node. That is exactly the window a cross-project focus lands in: switch project → load its nodes
 * → focus the target, all before React Flow's mount-time measuring has run. (Clicking an OS
 * notification for a session in another project is the everyday path into it; the same node focuses
 * correctly on a second try, once it is measured.)
 *
 * So for the unmeasured case we do the same maths ourselves from the size the node was persisted
 * with — which needs no layout — and drive the camera with `setViewport`.
 */

/** The subset of a React Flow node this module needs. Loose on purpose: it must accept both a
 *  freshly deserialized node (`width`/`height`, no `measured`) and a live measured one. */
export interface FocusableNode {
  id: string
  position: { x: number; y: number }
  parentId?: string
  width?: number | null
  height?: number | null
  measured?: { width?: number | null; height?: number | null }
  style?: { width?: number | string | null; height?: number | string | null }
}

/** Zoom/padding for framing a single node. Kept beside the maths so the fallback path and
 *  `fitView` cannot drift apart: the clamp keeps a small node from filling the screen and a
 *  huge one from being fit microscopic. */
export const FIT_NODE_OPTIONS = { padding: 0.2, minZoom: 0.25, maxZoom: 1.38 } as const

/** A `parentId` chain longer than this is a data bug (or a cycle) — stop walking. */
const MAX_PARENT_DEPTH = 20

const numeric = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

const sizeOf = (n: FocusableNode): { width: number; height: number } | null => {
  const width = numeric(n.measured?.width) ?? numeric(n.width) ?? numeric(n.style?.width)
  const height = numeric(n.measured?.height) ?? numeric(n.height) ?? numeric(n.style?.height)
  return width && height ? { width, height } : null
}

/**
 * The node's top-left in ABSOLUTE canvas coordinates. A grouped node's `position` is relative to
 * its group frame, so the parent chain is walked. Needs no size — unlike `nodeFitRect` this always
 * answers, which is what placement (as opposed to framing) needs: a node spawned next to a grouped
 * source must be positioned in the same space the source really occupies, not at its raw
 * group-relative `position`.
 */
export function absolutePosition(
  node: FocusableNode,
  all: readonly FocusableNode[]
): { x: number; y: number } {
  let x = node.position.x
  let y = node.position.y
  let parentId = node.parentId
  const seen = new Set<string>([node.id])
  for (let depth = 0; parentId && depth < MAX_PARENT_DEPTH; depth++) {
    if (seen.has(parentId)) break
    seen.add(parentId)
    const parent = all.find((n) => n.id === parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentId
  }
  return { x, y }
}

/**
 * The node's rect in ABSOLUTE canvas coordinates, or null when its size is unknowable (in which
 * case the caller must leave the camera alone — a zero-size rect is what produces the origin jump).
 */
export function nodeFitRect(node: FocusableNode, all: readonly FocusableNode[]): Rect | null {
  const size = sizeOf(node)
  if (!size) return null
  return { ...absolutePosition(node, all), ...size }
}

/** The viewport that frames `rect` in a `containerWidth × containerHeight` pane, with the same
 *  padding/zoom clamp `fitView` would have applied. Null when the container has no size yet. */
export function viewportForRect(
  rect: Rect,
  containerWidth: number,
  containerHeight: number
): Viewport | null {
  if (!(containerWidth > 0) || !(containerHeight > 0)) return null
  return getViewportForBounds(
    rect,
    containerWidth,
    containerHeight,
    FIT_NODE_OPTIONS.minZoom,
    FIT_NODE_OPTIONS.maxZoom,
    FIT_NODE_OPTIONS.padding
  )
}

/** Whether React Flow already knows this node's on-screen size — i.e. whether `fitView` will
 *  actually include it in its fit set. Takes the minimal shape so it reads either a user-land
 *  node or React Flow's own internal node (the authoritative one; see Canvas.goToNode). */
export function isMeasured(
  node: { measured?: { width?: number | null; height?: number | null } } | null | undefined
): boolean {
  return !!(numeric(node?.measured?.width) && numeric(node?.measured?.height))
}
