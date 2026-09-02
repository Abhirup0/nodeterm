import { describe, it, expect } from 'vitest'
import { Position } from '@xyflow/react'
import { borderExit, floatingEdgeParams, type Rect } from './floatingEdge'

const box = (x: number, y: number, width = 100, height = 50): Rect => ({ x, y, width, height })

describe('borderExit — where the centre-to-centre line leaves a rectangle', () => {
  it('exits the RIGHT side toward a point to the right', () => {
    expect(borderExit(box(0, 0), { x: 500, y: 25 })).toEqual({ x: 100, y: 25, position: Position.Right })
  })
  it('exits the LEFT side toward a point to the left', () => {
    expect(borderExit(box(0, 0), { x: -500, y: 25 })).toEqual({ x: 0, y: 25, position: Position.Left })
  })
  it('exits the BOTTOM toward a point below', () => {
    expect(borderExit(box(0, 0), { x: 50, y: 500 })).toEqual({ x: 50, y: 50, position: Position.Bottom })
  })
  it('exits the TOP toward a point above', () => {
    expect(borderExit(box(0, 0), { x: 50, y: -500 })).toEqual({ x: 50, y: 0, position: Position.Top })
  })
  it('a diagonal target picks the side the centre line crosses (|dx|/hw vs |dy|/hh; tie → left/right)', () => {
    // centre (50,25); toward (250,125): dx=200, dy=100 → |dx|·hh = |dy|·hw → right wins.
    const e = borderExit(box(0, 0), { x: 250, y: 125 })
    expect(e.position).toBe(Position.Right)
    // The point is the side's MIDPOINT, not the crossing: every edge leaving a side leaves from
    // one place, so arrows converge instead of fanning along the border.
    expect({ x: e.x, y: e.y }).toEqual({ x: 100, y: 25 })
  })
  it('restricted to the horizontal sides (context links use the left/right bridge handles), a target above still exits left or right', () => {
    expect(borderExit(box(0, 0), { x: 50, y: -500 }, 'horizontal')).toEqual({ x: 100, y: 25, position: Position.Right })
    expect(borderExit(box(0, 0), { x: -300, y: -500 }, 'horizontal')).toEqual({ x: 0, y: 25, position: Position.Left })
    expect(borderExit(box(0, 0), { x: 300, y: 500 }, 'horizontal')).toEqual({ x: 100, y: 25, position: Position.Right })
  })
  it('a coincident centre (overlapping nodes) degrades to the right side, never NaN', () => {
    const e = borderExit(box(0, 0), { x: 50, y: 25 })
    expect(Number.isFinite(e.x) && Number.isFinite(e.y)).toBe(true)
    expect(e.position).toBe(Position.Right)
  })
  it('a zero-size rectangle answers its own origin', () => {
    expect(borderExit({ x: 10, y: 20, width: 0, height: 0 }, { x: 99, y: 99 })).toEqual({ x: 10, y: 20, position: Position.Right })
  })
})

describe('floatingEdgeParams — both ends, facing each other', () => {
  it('a node left of another: source exits right, target enters left', () => {
    const p = floatingEdgeParams(box(0, 0), box(400, 0))
    expect(p).toEqual({ sx: 100, sy: 25, sourcePosition: Position.Right, tx: 400, ty: 25, targetPosition: Position.Left })
  })
  it('a node ABOVE another (the case the fixed handles got wrong): bottom → top, no loop', () => {
    const p = floatingEdgeParams(box(0, 0), box(0, 300))
    expect(p.sourcePosition).toBe(Position.Bottom)
    expect(p.targetPosition).toBe(Position.Top)
  })
  it('a target to the upper-left exits the source on its left/top side, not its right', () => {
    const p = floatingEdgeParams(box(1000, 1000), box(0, 0))
    expect([Position.Left, Position.Top]).toContain(p.sourcePosition)
    expect([Position.Right, Position.Bottom]).toContain(p.targetPosition)
    // The exact point is the TOP side's midpoint (the centre line crosses the top: |dy|·hw > |dx|·hh).
    expect({ x: p.sx, y: p.sy }).toEqual({ x: 1050, y: 1000 })
    expect({ x: p.tx, y: p.ty }).toEqual({ x: 50, y: 50 })
  })
  it('horizontal-only params: a node ABOVE another still connects right → left at the handle heights', () => {
    const p = floatingEdgeParams(box(0, 0), box(0, 300), 'horizontal')
    expect(p).toEqual({ sx: 100, sy: 25, sourcePosition: Position.Right, tx: 100, ty: 325, targetPosition: Position.Right })
  })
})
