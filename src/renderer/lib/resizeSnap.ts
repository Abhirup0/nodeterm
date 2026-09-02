import type { NodeChange } from '@xyflow/react'
import type { NodeKind } from '@shared/types'
import type { CanvasNode } from '../state/workspace'
import { containerOrigin, snapRectInRootSpace } from './gridSnap'

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
 *
 * Two coordinate rules make this agree with React Flow's own drag snap and with group frames:
 * the box is snapped in ROOT space (`snapRectInRootSpace`), and a frame's children are shifted
 * by whatever the snap moved the frame's origin (`childShifts`).
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

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>()
  // How far the snap moved each resized node's origin away from what React Flow proposed. Its
  // children are positioned against that origin, so they owe the opposite shift.
  const shifts = new Map<string, { x: number; y: number }>()

  for (const id of resizing) {
    const node = byId.get(id)
    if (!node) continue
    const moved = changes.find((c) => c.type === 'position' && c.id === id && c.position)
    const sized = changes.find((c) => c.type === 'dimensions' && c.id === id && c.dimensions)
    const position = (moved?.type === 'position' && moved.position) || node.position
    const dimensions = sized?.type === 'dimensions' ? sized.dimensions : undefined
    const width = dimensions?.width ?? node.measured?.width ?? (node.width as number) ?? 0
    const height = dimensions?.height ?? node.measured?.height ?? (node.height as number) ?? 0
    const snapped = snapRectInRootSpace(
      { x: position.x, y: position.y, width, height },
      containerOrigin(node.parentId, nodes),
      grid,
      (node.type ?? 'terminal') as NodeKind
    )
    boxes.set(id, {
      x: snapped.x,
      y: snapped.y,
      width: snapped.width,
      // A collapsed node keeps its collapsed bar height, exactly as align-to-grid leaves it.
      height: node.data?.collapsed ? height : snapped.height
    })
    shifts.set(id, { x: snapped.x - position.x, y: snapped.y - position.y })
  }

  const childShifts = new Map<string, { x: number; y: number }>()
  for (const [id, shift] of shifts) {
    if (shift.x === 0 && shift.y === 0) continue
    for (const node of nodes) {
      if (node.parentId === id) {
        childShifts.set(node.id, { x: -shift.x, y: -shift.y })
      }
    }
  }

  const positioned = new Set(
    changes.flatMap((c) => (c.type === 'position' && boxes.has(c.id) ? [c.id] : []))
  )
  const shifted = new Set<string>()
  const applied = changes.map((change) => {
    const box = 'id' in change ? boxes.get(change.id) : undefined
    if (box) {
      if (change.type === 'position' && change.position) {
        return { ...change, position: { x: box.x, y: box.y } }
      }
      if (change.type === 'dimensions' && change.dimensions) {
        return { ...change, dimensions: { width: box.width, height: box.height } }
      }
      return change
    }
    const shift = 'id' in change ? childShifts.get(change.id) : undefined
    if (shift && change.type === 'position' && change.position) {
      shifted.add(change.id)
      return { ...change, position: { x: change.position.x + shift.x, y: change.position.y + shift.y } }
    }
    return change
  })

  for (const [id, box] of boxes) {
    if (positioned.has(id)) continue
    const node = byId.get(id)
    if (!node || (node.position.x === box.x && node.position.y === box.y)) continue
    applied.push({ id, type: 'position', position: { x: box.x, y: box.y } })
  }
  // A right/bottom drag compensates no child of its own, because React Flow never moved the
  // frame's origin there - the snap did.
  for (const [id, shift] of childShifts) {
    if (shifted.has(id)) continue
    const node = byId.get(id)
    if (!node) continue
    applied.push({
      id,
      type: 'position',
      position: { x: node.position.x + shift.x, y: node.position.y + shift.y }
    })
  }
  return applied
}
