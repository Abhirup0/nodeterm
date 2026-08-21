import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import {
  FLOW_NODE_CLASS,
  isFocusTarget,
  nextNodeInDirection,
  nodeNearestPoint,
  type DirectionalNode
} from './directionalFocus'

/** A 200×100 node at (x, y) — small enough that a 300px pitch leaves real gaps between rows. */
const node = (id: string, x: number, y: number, extra: Partial<DirectionalNode> = {}): DirectionalNode => ({
  id,
  position: { x, y },
  width: 200,
  height: 100,
  ...extra
})

/**
 *   a   b   c      three columns, two rows, everything aligned:
 *   d   e   f      the plain case every other test is a deviation from.
 */
const grid = [
  node('a', 0, 0), node('b', 300, 0), node('c', 600, 0),
  node('d', 0, 300), node('e', 300, 300), node('f', 600, 300)
]

describe('nextNodeInDirection, on an aligned grid', () => {
  it('walks the row and the column one step at a time', () => {
    expect(nextNodeInDirection(grid, 'e', 'left')).toBe('d')
    expect(nextNodeInDirection(grid, 'e', 'right')).toBe('f')
    expect(nextNodeInDirection(grid, 'e', 'up')).toBe('b')
    expect(nextNodeInDirection(grid, 'b', 'down')).toBe('e')
  })

  it('does not wrap: the edge is the end of the line', () => {
    expect(nextNodeInDirection(grid, 'c', 'right')).toBeNull()
    expect(nextNodeInDirection(grid, 'a', 'left')).toBeNull()
    expect(nextNodeInDirection(grid, 'a', 'up')).toBeNull()
    expect(nextNodeInDirection(grid, 'f', 'down')).toBeNull()
  })

  it('prefers the nearer node in the same row over a nearer one diagonally', () => {
    // `f` is two columns away in a's row; `d` is one row down and dead below. Right must still
    // reach `b`, and nothing about the diagonal tier may outrank an in-row neighbour.
    expect(nextNodeInDirection(grid, 'a', 'right')).toBe('b')
  })
})

describe('nextNodeInDirection, when nothing lines up', () => {
  it('reaches a node no row overlap can explain', () => {
    // `far` shares no horizontal band with `origin`, so tier 0 is empty and the diagonal tier is
    // the only thing keeping this from being a dead end.
    const nodes = [node('origin', 0, 0), node('far', 500, 900)]
    expect(nextNodeInDirection(nodes, 'origin', 'right')).toBe('far')
  })

  it('the sideways penalty picks the nearly-aligned node over the closer diagonal one', () => {
    // `steep` is closer along x (400 vs 700) but 2000px off-axis; `flat` is further right and only
    // 150px off. PERPENDICULAR_WEIGHT is what makes `flat` the answer.
    const nodes = [node('origin', 0, 0), node('steep', 400, 2000), node('flat', 700, 150)]
    expect(nextNodeInDirection(nodes, 'origin', 'right')).toBe('flat')
  })

  it('a node the grid snapped into the same column is not "above" its neighbour', () => {
    const nodes = [node('left', 0, 0), node('right', 300, 0)]
    expect(nextNodeInDirection(nodes, 'left', 'up')).toBeNull()
    expect(nextNodeInDirection(nodes, 'left', 'down')).toBeNull()
  })
})

describe('nextNodeInDirection, the shapes it must not trip on', () => {
  it('skips group frames, which contain the origin rather than sit beside it', () => {
    const nodes = [
      node('origin', 0, 0),
      node('frame', 0, 0, { type: 'group', width: 2000, height: 2000 }),
      node('sibling', 300, 0)
    ]
    expect(nextNodeInDirection(nodes, 'origin', 'right')).toBe('sibling')
  })

  it('an unmeasured node is a point, still reachable', () => {
    const nodes = [
      node('origin', 0, 0),
      { id: 'fresh', position: { x: 400, y: 50 } } satisfies DirectionalNode
    ]
    expect(nextNodeInDirection(nodes, 'origin', 'right')).toBe('fresh')
  })

  it('reads measured sizes when the node was never resized by hand', () => {
    const nodes: DirectionalNode[] = [
      { id: 'origin', position: { x: 0, y: 0 }, measured: { width: 200, height: 100 } },
      { id: 'inrow', position: { x: 400, y: 40 }, measured: { width: 200, height: 100 } },
      { id: 'offrow', position: { x: 300, y: 900 }, measured: { width: 200, height: 100 } }
    ]
    expect(nextNodeInDirection(nodes, 'origin', 'right')).toBe('inrow')
  })

  it('one node with a broken position cannot poison the answer', () => {
    // NaN loses no comparison, it FAILS both of them, so an unguarded NaN candidate seen first
    // would hold `best` against every valid node behind it.
    const nodes: DirectionalNode[] = [
      node('origin', 0, 0),
      { id: 'broken', position: { x: NaN, y: NaN }, width: 200, height: 100 },
      node('real', 300, 0)
    ]
    expect(nextNodeInDirection(nodes, 'origin', 'right')).toBe('real')
  })

  it('an origin with a broken position moves nowhere rather than somewhere random', () => {
    const nodes: DirectionalNode[] = [
      { id: 'origin', position: { x: NaN, y: 0 }, width: 200, height: 100 },
      node('real', 300, 0)
    ]
    expect(nextNodeInDirection(nodes, 'origin', 'right')).toBeNull()
  })

  it('an origin that is not on this canvas answers null, never a guess', () => {
    expect(nextNodeInDirection(grid, 'gone', 'right')).toBeNull()
    expect(nextNodeInDirection([], 'a', 'right')).toBeNull()
  })

  it('breaks a true tie on id, so one canvas always answers the same way', () => {
    const nodes = [node('origin', 0, 0), node('zeta', 300, 0), node('alpha', 300, 0)]
    expect(nextNodeInDirection(nodes, 'origin', 'right')).toBe('alpha')
  })
})

describe('nextNodeInDirection, across coordinate spaces', () => {
  // A grouped node's `position` is relative to its frame. These cases are the reason every rect
  // goes through nodeFocus's absolutePosition instead of reading `position` directly.
  const framed: DirectionalNode[] = [
    node('frame', 4000, 0, { type: 'group', width: 1000, height: 500 }),
    { id: 'inside', position: { x: 24, y: 60 }, width: 200, height: 100, parentId: 'frame' },
    node('outside', 0, 60)
  ]

  it('a grouped node is where it really sits, not where its raw position says', () => {
    // Read raw, `inside` is at x=24 and would be the LEFTMOST node on the canvas; absolutely it
    // is at x=4024, far to the right of `outside`.
    expect(nextNodeInDirection(framed, 'outside', 'right')).toBe('inside')
    expect(nextNodeInDirection(framed, 'outside', 'left')).toBeNull()
  })

  it('and the move back out of the frame works the same way', () => {
    expect(nextNodeInDirection(framed, 'inside', 'left')).toBe('outside')
    expect(nextNodeInDirection(framed, 'inside', 'right')).toBeNull()
  })

  it('a parentId cycle does not hang the walk', () => {
    const cyclic: DirectionalNode[] = [
      { id: 'a', position: { x: 0, y: 0 }, width: 200, height: 100, parentId: 'b' },
      { id: 'b', position: { x: 300, y: 0 }, width: 200, height: 100, parentId: 'a' }
    ]
    expect(() => nextNodeInDirection(cyclic, 'a', 'right')).not.toThrow()
  })
})

describe('nodeNearestPoint', () => {
  it('seeds from the node nearest the view center', () => {
    expect(nodeNearestPoint(grid, { x: 700, y: 350 })).toBe('f')
    expect(nodeNearestPoint(grid, { x: 0, y: 0 })).toBe('a')
  })

  it('never seeds onto a group frame', () => {
    const nodes = [node('frame', 0, 0, { type: 'group' }), node('real', 5000, 5000)]
    expect(nodeNearestPoint(nodes, { x: 0, y: 0 })).toBe('real')
  })

  it('an empty canvas has no seed', () => {
    expect(nodeNearestPoint([], { x: 0, y: 0 })).toBeNull()
  })
})

describe('isFocusTarget', () => {
  it('every node kind but a group frame', () => {
    expect(isFocusTarget(node('t', 0, 0, { type: 'terminal' }))).toBe(true)
    expect(isFocusTarget(node('s', 0, 0, { type: 'sticky' }))).toBe(true)
    expect(isFocusTarget(node('g', 0, 0, { type: 'group' }))).toBe(false)
  })
})

describe('FLOW_NODE_CLASS', () => {
  it('still exists in the installed xyflow dist', () => {
    const dist = readFileSync('node_modules/@xyflow/react/dist/esm/index.js', 'utf8')
    expect(dist.includes(FLOW_NODE_CLASS)).toBe(true)
  })
})
