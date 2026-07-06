import { describe, it, expect } from 'vitest'
import { arrangeNodes, alignNodes, type CanvasNode } from './workspace'

// Minimal node stub: only the fields the layout fns read (id, position, width/height, parentId).
const n = (id: string, x: number, y: number, w = 100, h = 50): CanvasNode =>
  ({ id, type: 'terminal', position: { x, y }, width: w, height: h, data: { title: id, color: '#fff', group: null } }) as CanvasNode

describe('arrangeNodes', () => {
  it('lays out a row left-to-right from the bounding-box origin with the gap', () => {
    const out = arrangeNodes([n('a', 50, 90), n('b', 10, 200)], ['a', 'b'], { layout: 'row', gap: 20 })
    const a = out.find((x) => x.id === 'a')!
    const b = out.find((x) => x.id === 'b')!
    // origin = bounding-box top-left of current positions = (10, 90)
    expect(a.position).toEqual({ x: 10, y: 90 })
    expect(b.position).toEqual({ x: 10 + 100 + 20, y: 90 })
  })

  it('lays out a column top-to-bottom', () => {
    const out = arrangeNodes([n('a', 0, 0), n('b', 300, 300)], ['a', 'b'], { layout: 'column', gap: 10 })
    expect(out.find((x) => x.id === 'a')!.position).toEqual({ x: 0, y: 0 })
    expect(out.find((x) => x.id === 'b')!.position).toEqual({ x: 0, y: 50 + 10 })
  })

  it('grid wraps at cols and rows advance by the tallest node in the row', () => {
    const out = arrangeNodes(
      [n('a', 0, 0, 100, 50), n('b', 0, 0, 100, 80), n('c', 0, 0, 100, 50)],
      ['a', 'b', 'c'],
      { layout: 'grid', cols: 2, gap: 10, origin: { x: 0, y: 0 } }
    )
    expect(out.find((x) => x.id === 'a')!.position).toEqual({ x: 0, y: 0 })
    expect(out.find((x) => x.id === 'b')!.position).toEqual({ x: 110, y: 0 })
    // row 2 starts below the tallest of row 1 (80) + gap
    expect(out.find((x) => x.id === 'c')!.position).toEqual({ x: 0, y: 90 })
  })

  it('skips unknown ids and parented nodes; empty selection is a no-op', () => {
    const child = { ...n('kid', 5, 5), parentId: 'g1' } as CanvasNode
    const nodes = [n('a', 7, 7), child]
    const out = arrangeNodes(nodes, ['a', 'kid', 'ghost'], { layout: 'row', origin: { x: 0, y: 0 } })
    expect(out.find((x) => x.id === 'kid')!.position).toEqual({ x: 5, y: 5 }) // untouched
    expect(out.find((x) => x.id === 'a')!.position).toEqual({ x: 0, y: 0 })
    expect(arrangeNodes(nodes, ['ghost'])).toBe(nodes) // nothing resolvable → same array
  })
})

describe('alignNodes', () => {
  const pair = () => [n('a', 10, 20, 100, 50), n('b', 200, 300, 60, 80)]
  it('left aligns x to the min x', () => {
    const out = alignNodes(pair(), ['a', 'b'], 'left')
    expect(out.map((x) => x.position.x)).toEqual([10, 10])
  })
  it('right aligns right edges to the max right edge', () => {
    const out = alignNodes(pair(), ['a', 'b'], 'right')
    // max right = 200+60=260 → a.x=260-100=160, b.x=200
    expect(out.find((x) => x.id === 'a')!.position.x).toBe(160)
    expect(out.find((x) => x.id === 'b')!.position.x).toBe(200)
  })
  it('vcenter aligns vertical centers; hcenter aligns horizontal centers', () => {
    const v = alignNodes(pair(), ['a', 'b'], 'vcenter')
    // bbox y: 20..380 → center 200 → a.y=200-25=175, b.y=200-40=160
    expect(v.find((x) => x.id === 'a')!.position.y).toBe(175)
    expect(v.find((x) => x.id === 'b')!.position.y).toBe(160)
    const h = alignNodes(pair(), ['a', 'b'], 'hcenter')
    // bbox x: 10..260 → center 135 → a.x=85, b.x=105
    expect(h.find((x) => x.id === 'a')!.position.x).toBe(85)
    expect(h.find((x) => x.id === 'b')!.position.x).toBe(105)
  })
  it('unknown ids only → same array', () => {
    const nodes = pair()
    expect(alignNodes(nodes, ['ghost'], 'left')).toBe(nodes)
  })
})
