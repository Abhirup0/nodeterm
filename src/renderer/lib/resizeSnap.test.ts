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

/**
 * A group frame plus one child, the case React Flow compensates for itself: on a top/left drag
 * `XYResizer` shifts every child by the origin delta IT chose, so rewriting the frame underneath
 * those changes moves the children with it.
 */
const frame = (over: Partial<CanvasNode> = {}): CanvasNode =>
  ({
    id: 'g1',
    type: 'group',
    position: { x: 13, y: 7 },
    data: {},
    measured: { width: 613, height: 371 },
    ...over
  }) as CanvasNode

const child = (over: Partial<CanvasNode> = {}): CanvasNode =>
  ({
    id: 'c1',
    type: 'terminal',
    parentId: 'g1',
    extent: 'parent',
    position: { x: 100, y: 100 },
    data: {},
    measured: { width: 320, height: 240 },
    ...over
  }) as CanvasNode

const positionOf = (
  changes: NodeChange<CanvasNode>[],
  id: string
): { x: number; y: number } | undefined =>
  changes.flatMap((c) => (c.type === 'position' && c.id === id && c.position ? [c.position] : []))[0]

const resizeOf = (id: string, width: number, height: number): NodeChange<CanvasNode> =>
  ({ id, type: 'dimensions', resizing: true, dimensions: { width, height } }) as NodeChange<CanvasNode>

const moveOf = (id: string, x: number, y: number): NodeChange<CanvasNode> =>
  ({ id, type: 'position', position: { x, y } }) as NodeChange<CanvasNode>

describe('snapResizeChanges with a group frame', () => {
  it('keeps a child in place on a top-left drag', () => {
    // React Flow proposes the frame at -7 and compensates the child to 120, which restores the
    // child's original root x of 113. Snapping the frame to 0 without touching the child would
    // leave it at 120 instead.
    const changes = [moveOf('g1', -7, -13), resizeOf('g1', 633, 391), moveOf('c1', 120, 120)]
    const out = snapResizeChanges(changes, [frame(), child()], G)

    const framePos = positionOf(out, 'g1')!
    const childPos = positionOf(out, 'c1')!
    expect(framePos).toEqual({ x: 0, y: -20 })
    expect({ x: framePos.x + childPos.x, y: framePos.y + childPos.y }).toEqual({ x: 113, y: 107 })
  })

  it('keeps a child in place when snapping moves an edge React Flow never moved', () => {
    // A bottom-right drag emits no frame position change and no child changes at all, but the
    // snap still pulls the frame origin from 13 to 20, so the child owes the same compensation.
    const out = snapResizeChanges([resizeOf('g1', 633, 391)], [frame(), child()], G)

    const framePos = positionOf(out, 'g1')!
    const childPos = positionOf(out, 'c1')!
    expect({ x: framePos.x + childPos.x, y: framePos.y + childPos.y }).toEqual({ x: 113, y: 107 })
  })

  it('emits no child change when the snap leaves the frame origin where it was', () => {
    const on = frame({ position: { x: 40, y: 60 } })
    const out = snapResizeChanges([resizeOf('g1', 633, 391)], [on, child()], G)

    expect(positionOf(out, 'c1')).toBeUndefined()
  })

  it('snaps a nested frame against the CANVAS grid, not its own parent grid', () => {
    const outer = frame({
      id: 'g0',
      position: { x: -28, y: -62 },
      measured: { width: 900, height: 700 }
    })
    const inner = frame({ parentId: 'g0', extent: 'parent', position: { x: 41, y: 69 } })
    const out = snapResizeChanges([resizeOf('g1', 633, 391)], [outer, inner], G)

    const framePos = positionOf(out, 'g1') ?? inner.position
    expect(Math.abs((framePos.x + outer.position.x) % G)).toBe(0)
    expect(Math.abs((framePos.y + outer.position.y) % G)).toBe(0)
  })
})
