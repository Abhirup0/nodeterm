import type { NodeChange } from '@xyflow/react'
import type { NodeKind } from '@shared/types'
import type { CanvasNode } from '../state/workspace'
import { snapNodeToGrid } from './nodeSizing'

/**
 * React Flow snaps the resize DELTA, never the resulting edges. From `getDimensionsAfterResize`
 * (@xyflow/system): `newWidth = startWidth + distX`, where both pointer reads are snapped so
 * `distX` is a grid multiple. Added to an off-grid start width, the result is off-grid forever:
 * the size the user aims for is unreachable however carefully they drag.
 *
 * So the resizer's changes are re-snapped BEFORE they are applied, which is what makes the node
 * track the grid during the drag rather than jump when it ends. `resizing` is the marker: only
 * the resizer sets it, while the ResizeObserver's measurement changes carry no such field and
 * must pass through untouched, or every node's measured size would be forced onto the grid.
 *
 * A right/bottom-handle drag sends no position change, so one is ADDED when snapping moves the
 * anchored edge. Without it the node keeps an off-grid x while its width is measured from a
 * snapped one, and the right edge lands between grid lines again.
 */
export function snapResizeChanges(
  changes: NodeChange<CanvasNode>[],
  nodes: CanvasNode[],
  grid: number
): NodeChange<CanvasNode>[] {
  const resizing = new Set(
    changes.flatMap((c) => (c.type === 'dimensions' && typeof c.resizing === 'boolean' ? [c.id] : []))
  )
  if (!resizing.size || grid <= 0) return changes

  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>()
  for (const id of resizing) {
    const node = nodes.find((n) => n.id === id)
    if (!node) continue
    const moved = changes.find((c) => c.type === 'position' && c.id === id && c.position)
    const sized = changes.find((c) => c.type === 'dimensions' && c.id === id && c.dimensions)
    const position = (moved?.type === 'position' && moved.position) || node.position
    const dimensions = sized?.type === 'dimensions' ? sized.dimensions : undefined
    const width = dimensions?.width ?? node.measured?.width ?? (node.width as number) ?? 0
    const height = dimensions?.height ?? node.measured?.height ?? (node.height as number) ?? 0
    const snapped = snapNodeToGrid(grid, (node.type ?? 'terminal') as NodeKind, {
      x: position.x,
      y: position.y,
      width,
      height
    })
    // A collapsed node keeps its collapsed bar height, exactly as align-to-grid leaves it.
    // `+ 0` normalizes the -0 that rounding a small negative coordinate produces, which would
    // otherwise ride into node positions on every resize near the origin.
    boxes.set(id, {
      x: snapped.x + 0,
      y: snapped.y + 0,
      width: snapped.width,
      height: node.data?.collapsed ? height : snapped.height
    })
  }

  const positioned = new Set(
    changes.flatMap((c) => (c.type === 'position' && boxes.has(c.id) ? [c.id] : []))
  )
  const applied = changes.map((change) => {
    const box = 'id' in change ? boxes.get(change.id) : undefined
    if (!box) return change
    if (change.type === 'position' && change.position) {
      return { ...change, position: { x: box.x, y: box.y } }
    }
    if (change.type === 'dimensions' && change.dimensions) {
      return { ...change, dimensions: { width: box.width, height: box.height } }
    }
    return change
  })

  for (const [id, box] of boxes) {
    if (positioned.has(id)) continue
    const node = nodes.find((n) => n.id === id)
    if (!node || (node.position.x === box.x && node.position.y === box.y)) continue
    applied.push({ id, type: 'position', position: { x: box.x, y: box.y } })
  }
  return applied
}
