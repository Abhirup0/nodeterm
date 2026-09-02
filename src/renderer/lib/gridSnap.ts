import type { NodeKind } from '@shared/types'
import type { CanvasNode } from '../state/workspace'
import { rootPosition } from '../state/workspace'
import { snapNodeToGrid, type Rect } from './nodeSizing'

export interface Point {
  x: number
  y: number
}

const ROOT_ORIGIN: Point = { x: 0, y: 0 }

/**
 * Root-space origin of the container `parentId` names: (0, 0) for a top-level object, else the
 * frame's own root position. A missing frame resolves to the root rather than throwing, matching
 * how the rest of the canvas treats a dangling parentId.
 */
export function containerOrigin(parentId: string | undefined, nodes: CanvasNode[]): Point {
  if (!parentId) return ROOT_ORIGIN
  const frame = nodes.find((node) => node.id === parentId)
  if (!frame) return ROOT_ORIGIN
  return rootPosition(frame, nodes)
}

/**
 * Snap a CONTAINER-relative point onto the canvas grid.
 *
 * React Flow snaps a drag in flow (root) coordinates and only converts to parent-relative
 * afterwards: `XYDrag` runs `snapPosition(nextPosition, snapGrid)` and `calculateNodePosition`
 * subtracts the parent origin after that. Rounding a parent-relative value directly instead puts
 * the object on the FRAME's grid, and `groupSelectedNodes` creates frames at
 * `(minX - 28, minY - 62)`, so an off-grid frame origin is the normal case — the two grids then
 * differ by the frame's own fractional offset and the first drag moves the object again.
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
