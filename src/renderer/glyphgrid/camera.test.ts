import { describe, expect, it } from 'vitest'
import {
  rectsIntersect,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  type Camera
} from './camera'

describe('glyphgrid camera', () => {
  const cam: Camera = { x: 100, y: -50, zoom: 0.5 }

  it('worldToScreen matches the React Flow viewport convention (screen = world*zoom + pan)', () => {
    expect(worldToScreen(0, 0, cam)).toEqual({ x: 100, y: -50 })
    expect(worldToScreen(200, 300, cam)).toEqual({ x: 200, y: 100 })
  })

  it('screenToWorld inverts worldToScreen exactly', () => {
    const s = worldToScreen(123.5, -77.25, cam)
    const w = screenToWorld(s.x, s.y, cam)
    expect(w.x).toBeCloseTo(123.5, 10)
    expect(w.y).toBeCloseTo(-77.25, 10)
  })

  it('visibleWorldRect maps the screen viewport into world space', () => {
    const r = visibleWorldRect(cam, 800, 600)
    expect(r).toEqual({ x: -200, y: 100, w: 1600, h: 1200 })
  })

  it('rectsIntersect: overlapping, touching and disjoint', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 }
    expect(rectsIntersect(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true)
    expect(rectsIntersect(a, { x: 10, y: 0, w: 5, h: 5 })).toBe(false) // edge-touch = not visible
    expect(rectsIntersect(a, { x: 20, y: 20, w: 1, h: 1 })).toBe(false)
  })
})
