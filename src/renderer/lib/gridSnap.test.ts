import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../state/workspace'
import { containerOrigin, snapPointInRootSpace, snapRectInRootSpace } from './gridSnap'

const G = 20

const node = (
  id: string,
  type: string,
  pos: { x: number; y: number },
  parentId?: string
): CanvasNode =>
  ({
    id,
    type,
    position: pos,
    width: 320,
    height: 240,
    data: { title: id, color: '#888', group: null },
    ...(parentId ? { parentId, extent: 'parent' as const } : {})
  }) as unknown as CanvasNode

// `groupSelectedNodes` creates a frame at (minX - 28, minY - 62), so an off-grid frame origin is
// the normal case rather than an edge case.
const FRAME = { x: -28, y: -62 }

// `%` keeps the sign of its left operand, so a negative grid multiple yields -0 and `toBe(0)`
// fails on a value that is on the grid.
const onGrid = (value: number): boolean => Math.abs(value % G) === 0

describe('containerOrigin', () => {
  it('is the root for a top-level object', () => {
    expect(containerOrigin(undefined, [])).toEqual({ x: 0, y: 0 })
  })

  it('is the frame own root position', () => {
    const nodes = [node('g1', 'group', FRAME)]
    expect(containerOrigin('g1', nodes)).toEqual(FRAME)
  })

  it('sums every ancestor frame in a nested tree', () => {
    const nodes = [node('g1', 'group', { x: 100, y: 50 }), node('g2', 'group', { x: 7, y: 3 }, 'g1')]
    expect(containerOrigin('g2', nodes)).toEqual({ x: 107, y: 53 })
  })

  it('falls back to the root for a dangling parentId', () => {
    expect(containerOrigin('gone', [node('g1', 'group', FRAME)])).toEqual({ x: 0, y: 0 })
  })
})

describe('snapPointInRootSpace', () => {
  it('snaps a top-level point onto the canvas grid', () => {
    expect(snapPointInRootSpace({ x: 113, y: 47 }, { x: 0, y: 0 }, G)).toEqual({ x: 120, y: 40 })
  })

  it('lands a card inside an off-grid frame on the CANVAS grid, not the frame grid', () => {
    // The card's stored position is frame-relative; only origin + position is on the canvas.
    const out = snapPointInRootSpace({ x: 113, y: 47 }, FRAME, G)
    expect(out.x + FRAME.x).toBe(80)
    expect(out.y + FRAME.y).toBe(-20)
    expect(onGrid(out.x + FRAME.x)).toBe(true)
    expect(onGrid(out.y + FRAME.y)).toBe(true)
  })

  it('is what React Flow drag snap would produce, so the first drag does not move the card', () => {
    const position = { x: 113, y: 47 }
    const snapped = snapPointInRootSpace(position, FRAME, G)
    // XYDrag: snap in flow coordinates, then subtract the parent origin.
    const dragged = {
      x: Math.round((snapped.x + FRAME.x) / G) * G - FRAME.x,
      y: Math.round((snapped.y + FRAME.y) / G) * G - FRAME.y
    }
    expect(dragged).toEqual(snapped)
  })

  it('rounding frame-relative instead would put the card on a different grid', () => {
    // The bug this helper exists for: the old math rounded the composed frame-relative value.
    const frameRelative = { x: Math.round(113 / G) * G, y: Math.round(47 / G) * G }
    expect(snapPointInRootSpace({ x: 113, y: 47 }, FRAME, G)).not.toEqual(frameRelative)
  })

  it('normalizes -0 so it never reaches project.json', () => {
    const out = snapPointInRootSpace({ x: -2, y: -3 }, { x: 0, y: 0 }, G)
    expect(Object.is(out.x, -0)).toBe(false)
    expect(Object.is(out.y, -0)).toBe(false)
  })

  it('is a no-op when snapping is off', () => {
    const point = { x: 113, y: 47 }
    expect(snapPointInRootSpace(point, FRAME, 0)).toBe(point)
  })
})

describe('snapRectInRootSpace', () => {
  it('snaps every edge of a top-level rect onto the grid', () => {
    const out = snapRectInRootSpace(
      { x: 113, y: 47, width: 331, height: 205 },
      { x: 0, y: 0 },
      G,
      'terminal'
    )
    expect(onGrid(out.x)).toBe(true)
    expect(onGrid(out.y)).toBe(true)
    expect(onGrid(out.x + out.width)).toBe(true)
    expect(onGrid(out.y + out.height)).toBe(true)
  })

  it('puts a child rect edges on the CANVAS grid, not the frame grid', () => {
    const out = snapRectInRootSpace({ x: 113, y: 47, width: 331, height: 205 }, FRAME, G, 'terminal')
    expect(onGrid(out.x + FRAME.x)).toBe(true)
    expect(onGrid(out.y + FRAME.y)).toBe(true)
    expect(onGrid(out.x + FRAME.x + out.width)).toBe(true)
    expect(onGrid(out.y + FRAME.y + out.height)).toBe(true)
  })

  it('is a no-op when snapping is off', () => {
    const rect = { x: 113, y: 47, width: 331, height: 205 }
    expect(snapRectInRootSpace(rect, FRAME, 0, 'terminal')).toBe(rect)
  })
})
