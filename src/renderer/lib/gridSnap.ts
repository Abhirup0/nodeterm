import type { NodeKind } from '@shared/types'
import { snapNodeToGrid, type Rect } from './nodeSizing'

export interface Point {
  x: number
  y: number
}

// One home, in the module that owns `rootPosition`; re-exported so this stays the import site
// every snap caller already uses.
export { containerOrigin } from '../state/workspace'

/**
 * Snap a CONTAINER-relative point onto the canvas grid.
 *
 * React Flow snaps a drag in flow (root) coordinates and only converts to parent-relative
 * afterwards: `XYDrag` runs `snapPosition(nextPosition, snapGrid)` and `calculateNodePosition`
 * subtracts the parent origin after that. Rounding a parent-relative value directly instead puts
 * the object on the FRAME's grid, and the two grids then differ by the frame's own fractional
 * offset, so the first drag moves the object again.
 *
 * `groupSelectedNodes` now places a frame on the grid when snapping is on, but this stays
 * load-bearing: a frame created with snapping off, or moved while it was off, keeps a fractional
 * origin for the rest of its life.
 */
export function snapPointInRootSpace(point: Point, origin: Point, grid: number): Point {
  if (grid <= 0) return point
  const x = Math.round((point.x + origin.x) / grid) * grid - origin.x
  const y = Math.round((point.y + origin.y) / grid) * grid - origin.y
  // `+ 0` normalizes the -0 that rounding a small negative coordinate produces, which would
  // otherwise ride into node positions and out to project.json.
  return { x: x + 0, y: y + 0 }
}

/**
 * Snap a CONTAINER-relative rect onto the canvas grid, in root space for the reason above, then
 * hand it back in the caller's coordinate space. Sizes are grid deltas, so only the origin has to
 * cross spaces.
 */
export function snapRectInRootSpace(rect: Rect, origin: Point, grid: number, kind: NodeKind): Rect {
  if (grid <= 0) return rect
  const snapped = snapNodeToGrid(grid, kind, {
    x: rect.x + origin.x,
    y: rect.y + origin.y,
    width: rect.width,
    height: rect.height
  })
  return {
    x: snapped.x - origin.x + 0,
    y: snapped.y - origin.y + 0,
    width: snapped.width,
    height: snapped.height
  }
}
