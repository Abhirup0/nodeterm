import { describe, expect, it } from 'vitest'
import type { NodeChange } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'
import { snapResizeChanges } from './resizeSnap'

const G = 20

/** A terminal node sitting off-grid, which is the only case the whole module exists for. */
function node(over: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'n1',
    type: 'terminal',
    position: { x: 13, y: 7 },
    data: {},
    measured: { width: 613, height: 371 },
    ...over
  } as CanvasNode
}

const resize = (width: number, height: number, resizing = true): NodeChange<CanvasNode> =>
  ({ id: 'n1', type: 'dimensions', resizing, dimensions: { width, height } }) as NodeChange<CanvasNode>

const dims = (changes: NodeChange<CanvasNode>[]): { width: number; height: number } | undefined =>
  changes.flatMap((c) => (c.type === 'dimensions' && c.dimensions ? [c.dimensions] : []))[0]

const pos = (changes: NodeChange<CanvasNode>[]): { x: number; y: number } | undefined =>
  changes.flatMap((c) => (c.type === 'position' && c.position ? [c.position] : []))[0]

describe('snapResizeChanges', () => {
  it('lands an in-flight resize on grid multiples, not on start + a multiple', () => {
    // What React Flow proposes: 613 + 20, off-grid like the 613 it started from. Snapped, the
    // node runs from x 20 to a right edge on 640, so 620 wide.
    const out = snapResizeChanges([resize(633, 391)], [node()], G)

    expect(dims(out)).toEqual({ width: 620, height: 400 })
  })

  it('does the same on the final change, so releasing does not undo the drag', () => {
    const out = snapResizeChanges([resize(633, 391, false)], [node()], G)

    expect(dims(out)).toEqual({ width: 620, height: 400 })
  })

  it('adds a position change when snapping moves the anchored edge', () => {
    // A right/bottom-handle drag sends no position change of its own.
    const out = snapResizeChanges([resize(633, 391)], [node()], G)

    expect(pos(out)).toEqual({ x: 20, y: 0 })
  })

  it('adds none when the node already sits on the grid', () => {
    const out = snapResizeChanges([resize(633, 391)], [node({ position: { x: 40, y: 60 } })], G)

    expect(pos(out)).toBeUndefined()
  })

  it('rewrites a left-handle drag in place rather than appending a second position', () => {
    const changes: NodeChange<CanvasNode>[] = [
      { id: 'n1', type: 'position', position: { x: -7, y: 7 } } as NodeChange<CanvasNode>,
      resize(633, 391)
    ]
    const out = snapResizeChanges(changes, [node()], G)

    expect(out.filter((c) => c.type === 'position')).toHaveLength(1)
    expect(pos(out)).toEqual({ x: 0, y: 0 })
  })

  it('leaves a MEASUREMENT change alone: only the resizer sets `resizing`', () => {
    // Forcing the ResizeObserver's reading onto the grid would fight the DOM on every node.
    const measured: NodeChange<CanvasNode>[] = [
      { id: 'n1', type: 'dimensions', dimensions: { width: 613, height: 371 } } as NodeChange<CanvasNode>
    ]

    expect(snapResizeChanges(measured, [node()], G)).toEqual(measured)
  })

  it('passes a batch with no resize through untouched', () => {
    const changes: NodeChange<CanvasNode>[] = [
      { id: 'n1', type: 'select', selected: true } as NodeChange<CanvasNode>
    ]

    expect(snapResizeChanges(changes, [node()], G)).toBe(changes)
  })

  it('keeps a collapsed node at its bar height', () => {
    const collapsed = node({
      data: { title: 'n', color: '#0a84ff', group: null, collapsed: true },
      measured: { width: 613, height: 34 }
    })
    const out = snapResizeChanges([resize(633, 34)], [collapsed], G)

    expect(dims(out)?.height).toBe(34)
    expect(dims(out)?.width).toBe(620)
  })

  it('leaves a change for a node it cannot find alone', () => {
    const changes = [resize(633, 391)]

    expect(snapResizeChanges(changes, [], G)).toEqual(changes)
  })
})
