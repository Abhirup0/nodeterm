import { describe, it, expect } from 'vitest'
import { NODE_MIN_SIZES, expandRectToGrid, snapNodeToGrid } from './nodeSizing'
import type { NodeKind } from '@shared/types'

const G = 24

describe('snapNodeToGrid', () => {
  it('snaps each edge to its nearest grid line', () => {
    // x=10 -> 0, y=10 -> 0, right=210 -> 216, bottom=210 -> 216
    const r = snapNodeToGrid(G, 'sticky', { x: 10, y: 10, width: 200, height: 200 })
    expect(r).toEqual({ x: 0, y: 0, width: 216, height: 216 })
  })

  it('lands every corner on a grid intersection', () => {
    const r = snapNodeToGrid(G, 'sticky', { x: 10, y: 10, width: 200, height: 200 })
    expect(r.x % G).toBe(0)
    expect(r.y % G).toBe(0)
    expect((r.x + r.width) % G).toBe(0)
    expect((r.y + r.height) % G).toBe(0)
  })

  it('leaves an already-aligned, above-minimum node untouched', () => {
    // terminal grid-aligned minimum is 264x168
    const r = snapNodeToGrid(G, 'terminal', { x: 0, y: 0, width: 264, height: 168 })
    expect(r).toEqual({ x: 0, y: 0, width: 264, height: 168 })
  })

  it('rounds edges independently — right edge goes to its own nearest line, not left + rounded width', () => {
    // right=210 -> 216 (nearest), so width is 216. A "round size" scheme would give
    // round(200/24)*24 = 192 and a right edge at 192 — farther from 210.
    const r = snapNodeToGrid(G, 'sticky', { x: 10, y: 0, width: 200, height: 140 })
    expect(r).toEqual({ x: 0, y: 0, width: 216, height: 144 })
  })

  it('clamps a tiny node up to the kind grid-aligned minimum', () => {
    // terminal min 260x160 -> grid-aligned ceil(260/24)*24 = 264, ceil(160/24)*24 = 168
    const r = snapNodeToGrid(G, 'terminal', { x: 5, y: 5, width: 20, height: 20 })
    expect(r).toEqual({ x: 0, y: 0, width: 264, height: 168 })
  })

  it('clamps at a large grid size without inverting (a sub-grid box grows to the minimum)', () => {
    // grid 96, sticky 160x120 -> grid-aligned ceil(160/96)*96 = 192, ceil(120/96)*96 = 192
    const r = snapNodeToGrid(96, 'sticky', { x: 10, y: 10, width: 20, height: 20 })
    expect(r).toEqual({ x: 0, y: 0, width: 192, height: 192 })
  })

  it('keeps a size that already clears the minimum at its snapped value', () => {
    const r = snapNodeToGrid(G, 'sticky', { x: 10, y: 10, width: 200, height: 200 })
    // snapped 216x216 is above sticky's grid-aligned min (168x120), so no clamp
    expect(r.width).toBe(216)
    expect(r.height).toBe(216)
  })

  // What the resize wiring needs: React Flow adds a grid-multiple DELTA to whatever width the
  // node started at, so an off-grid node can never reach a multiple by resizing. One snap has to
  // land it there from any start, or the correction only moves the problem.
  it('lands any off-grid box on grid multiples in one step', () => {
    for (let width = 263; width < 420; width += 7) {
      const r = snapNodeToGrid(20, 'terminal', { x: 13, y: 7, width, height: width - 90 })

      expect([r.x % 20, r.y % 20, r.width % 20, r.height % 20]).toEqual([0, 0, 0, 0])
    }
  })

  it('is idempotent, so the next resize starts from a clean base', () => {
    const once = snapNodeToGrid(20, 'terminal', { x: 13, y: 7, width: 331, height: 199 })

    expect(snapNodeToGrid(20, 'terminal', once)).toEqual(once)
  })

  it('every kind has a positive min-size entry', () => {
    const kinds: NodeKind[] = [
      'terminal', 'sticky', 'group', 'editor', 'diff',
      'video', 'web', 'browser', 'subagent', 'loop', 'dino'
    ]
    for (const k of kinds) {
      expect(NODE_MIN_SIZES[k]).toBeDefined()
      expect(NODE_MIN_SIZES[k].width).toBeGreaterThan(0)
      expect(NODE_MIN_SIZES[k].height).toBeGreaterThan(0)
    }
  })
})

describe('expandRectToGrid', () => {
  it('grows the rect outward: left/top floor, right/bottom ceil', () => {
    // x=10 -> 0 (not the nearer 24), right=210 -> 216, so the rect only ever gains area.
    const r = expandRectToGrid(G, 'sticky', { x: 10, y: 10, width: 200, height: 200 })
    expect(r).toEqual({ x: 0, y: 0, width: 216, height: 216 })
  })

  it('never pulls an edge inward, where nearest-rounding would', () => {
    // x=20 is nearer to 24 than to 0, so snapNodeToGrid moves the left edge RIGHT by 4,
    // eating 4px of whatever clearance the caller put there.
    const rect = { x: 20, y: 20, width: 400, height: 400 }
    expect(snapNodeToGrid(G, 'group', rect).x).toBe(24)
    const grown = expandRectToGrid(G, 'group', rect)
    expect(grown.x).toBe(0)
    expect(grown.y).toBeLessThanOrEqual(rect.y)
    expect(grown.x + grown.width).toBeGreaterThanOrEqual(rect.x + rect.width)
    expect(grown.y + grown.height).toBeGreaterThanOrEqual(rect.y + rect.height)
  })

  it('lands every corner on a grid intersection, negative origins included', () => {
    const r = expandRectToGrid(G, 'sticky', { x: -13, y: -47, width: 190, height: 205 })
    // Math.abs: a negative multiple modulo the grid is -0, which toBe distinguishes from 0.
    expect(Math.abs(r.x % G)).toBe(0)
    expect(Math.abs(r.y % G)).toBe(0)
    expect(Math.abs((r.x + r.width) % G)).toBe(0)
    expect(Math.abs((r.y + r.height) % G)).toBe(0)
  })

  it('raises a small rect to the kind grid-aligned minimum, extending right/bottom only', () => {
    const r = expandRectToGrid(G, 'group', { x: 0, y: 0, width: 10, height: 10 })
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
    expect(r.width).toBeGreaterThanOrEqual(NODE_MIN_SIZES.group.width)
    expect(r.height).toBeGreaterThanOrEqual(NODE_MIN_SIZES.group.height)
  })

  it('normalizes -0 so it cannot ride into a persisted position', () => {
    const r = expandRectToGrid(G, 'sticky', { x: -0, y: -0, width: 240, height: 240 })
    expect(Object.is(r.x, -0)).toBe(false)
    expect(Object.is(r.y, -0)).toBe(false)
  })
})
