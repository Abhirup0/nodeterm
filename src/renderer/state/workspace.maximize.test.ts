import { describe, it, expect } from 'vitest'
import {
  flowToNodeStates,
  maximizeNodeToRect,
  nodeStatesToFlow,
  placeNodeInRect,
  restoreMaximizedNode
} from './workspace'
import type { CanvasNode } from './workspace'
import { maximizeTargetRect } from '../lib/nodeMaximize'

// Maximize-to-viewport (issue #399): the node is RESIZED to the visible canvas and toggles back
// to the exact rect it had — the restore is the half users cannot do by hand, so it is the half
// these tests pin hardest.

const term = (
  id: string,
  pos: { x: number; y: number },
  size = { width: 320, height: 240 },
  extra: Partial<CanvasNode> = {}
): CanvasNode =>
  ({
    id,
    type: 'terminal',
    position: pos,
    width: size.width,
    height: size.height,
    style: { width: size.width, height: size.height },
    data: { title: id, color: '#fff', group: null },
    ...extra
  }) as CanvasNode

const group = (id: string, pos: { x: number; y: number }, size = { width: 600, height: 500 }): CanvasNode =>
  ({
    id,
    type: 'group',
    position: pos,
    width: size.width,
    height: size.height,
    style: { width: size.width, height: size.height },
    data: { title: id, color: '#fff', group: null }
  }) as CanvasNode

const RECT = { x: 1000, y: 2000, width: 1600, height: 900 }

describe('maximizeNodeToRect', () => {
  it('resizes a top-level node to the rect and remembers the previous rect', () => {
    const nodes = [term('a', { x: 40, y: 60 })]
    const next = maximizeNodeToRect(nodes, 'a', RECT)
    const a = next.find((n) => n.id === 'a')!
    expect(a.position).toEqual({ x: 1000, y: 2000 })
    expect(a.width).toBe(1600)
    expect(a.height).toBe(900)
    expect(a.style).toMatchObject({ width: 1600, height: 900 })
    expect(a.data.premaxRect).toEqual({ x: 40, y: 60, width: 320, height: 240 })
  })

  it('drops the stale measurement so a same-tick persist serializes the NEW size', () => {
    const nodes = [term('a', { x: 0, y: 0 }, { width: 320, height: 240 }, {
      measured: { width: 320, height: 240 }
    })]
    const next = maximizeNodeToRect(nodes, 'a', RECT)
    const state = flowToNodeStates(next).find((s) => s.id === 'a')!
    expect(state.size).toEqual({ width: 1600, height: 900 })
  })

  it('is a no-op for unknown ids, group frames, collapsed nodes and already-maximized nodes', () => {
    const collapsed = term('c', { x: 0, y: 0 })
    collapsed.data = { ...collapsed.data, collapsed: true }
    const maxed = maximizeNodeToRect([term('m', { x: 0, y: 0 })], 'm', RECT)
    expect(maximizeNodeToRect([term('a', { x: 0, y: 0 })], 'nope', RECT)).toEqual([
      term('a', { x: 0, y: 0 })
    ])
    expect(maximizeNodeToRect([group('g', { x: 0, y: 0 })], 'g', RECT)[0].width).toBe(600)
    expect(maximizeNodeToRect([collapsed], 'c', RECT)[0].data.premaxRect).toBeUndefined()
    expect(maximizeNodeToRect(maxed, 'm', RECT)).toEqual(maxed)
  })

  it('writes a grouped node parent-relative and re-fits the frame around it', () => {
    const g = group('g', { x: 100, y: 100 })
    const child = term('a', { x: 50, y: 80 }, { width: 320, height: 240 }, { parentId: 'g', extent: 'parent' })
    const next = maximizeNodeToRect([g, child], 'a', RECT)
    const a = next.find((n) => n.id === 'a')!
    const frame = next.find((n) => n.id === 'g')!
    // Absolute position must equal the rect; relative = rect − frame origin (post-fit).
    expect(frame.position.x + a.position.x).toBeCloseTo(RECT.x)
    expect(frame.position.y + a.position.y).toBeCloseTo(RECT.y)
    // The frame now contains the maximized child (extent:'parent' cannot clamp it).
    expect(frame.position.x).toBeLessThanOrEqual(RECT.x)
    expect((frame.width as number)!).toBeGreaterThanOrEqual(RECT.width)
  })
})

describe('restoreMaximizedNode', () => {
  it('round-trips a top-level node back to the exact previous rect', () => {
    const nodes = [term('a', { x: 40, y: 60 })]
    const restored = restoreMaximizedNode(maximizeNodeToRect(nodes, 'a', RECT), 'a')
    const a = restored.find((n) => n.id === 'a')!
    expect(a.position).toEqual({ x: 40, y: 60 })
    expect(a.width).toBe(320)
    expect(a.height).toBe(240)
    expect(a.data.premaxRect).toBeUndefined()
    expect(a.data.expandedHeight).toBe(240)
  })

  it('round-trips a grouped node: same absolute rect, frame re-fitted back down', () => {
    const g = group('g', { x: 100, y: 100 })
    const other = term('b', { x: 30, y: 70 }, { width: 200, height: 150 }, { parentId: 'g', extent: 'parent' })
    const child = term('a', { x: 260, y: 80 }, { width: 320, height: 240 }, { parentId: 'g', extent: 'parent' })
    const before = [g, other, child]
    const restored = restoreMaximizedNode(maximizeNodeToRect(before, 'a', RECT), 'a')
    const a = restored.find((n) => n.id === 'a')!
    // The OTHER child's absolute position never moved across the whole cycle.
    const frame = restored.find((n) => n.id === 'g')!
    const b = restored.find((n) => n.id === 'b')!
    expect(frame.position.x + b.position.x).toBeCloseTo(100 + 30)
    expect(frame.position.y + b.position.y).toBeCloseTo(100 + 70)
    expect(frame.position.x + a.position.x).toBeCloseTo(100 + 260)
    expect(frame.position.y + a.position.y).toBeCloseTo(100 + 80)
    expect(a.width).toBe(320)
    expect(a.height).toBe(240)
  })

  it('is a no-op when the node is not maximized', () => {
    const nodes = [term('a', { x: 1, y: 2 })]
    expect(restoreMaximizedNode(nodes, 'a')).toEqual(nodes)
  })
})

describe('premaxRect persistence', () => {
  it('survives the flow → state → flow round trip', () => {
    const maxed = maximizeNodeToRect([term('a', { x: 40, y: 60 })], 'a', RECT)
    const back = nodeStatesToFlow(flowToNodeStates(maxed))
    expect(back[0].data.premaxRect).toEqual({ x: 40, y: 60, width: 320, height: 240 })
    // ...and the restore still works on the rehydrated node.
    const restored = restoreMaximizedNode(back as CanvasNode[], 'a')
    expect(restored[0].position).toEqual({ x: 40, y: 60 })
    expect(restored[0].width).toBe(320)
  })
})

describe('maximizeTargetRect', () => {
  it('converts the visible pane to flow coordinates, inset by the margin', () => {
    // zoom 1, camera at origin: flow == screen.
    expect(maximizeTargetRect({ x: 0, y: 0, zoom: 1 }, 1200, 800, 24)).toEqual({
      x: 24,
      y: 24,
      width: 1152,
      height: 752
    })
    // zoom 0.5, panned: flow rect is twice the screen size, offset by the camera.
    expect(maximizeTargetRect({ x: -100, y: 50, zoom: 0.5 }, 1200, 800, 24)).toEqual({
      x: (24 + 100) / 0.5,
      y: (24 - 50) / 0.5,
      width: 1152 / 0.5,
      height: 752 / 0.5
    })
  })

  it('refuses a container that has no usable size', () => {
    expect(maximizeTargetRect({ x: 0, y: 0, zoom: 1 }, 0, 0, 24)).toBeNull()
    expect(maximizeTargetRect({ x: 0, y: 0, zoom: 1 }, 160, 800, 24)).toBeNull()
    expect(maximizeTargetRect({ x: 0, y: 0, zoom: 0 }, 1200, 800, 24)).toBeNull()
  })
})

describe('placeNodeInRect (zone snap, issue #394 v1)', () => {
  it('places a top-level node at the rect without writing premaxRect', () => {
    const next = placeNodeInRect([term('a', { x: 40, y: 60 })], 'a', RECT)
    const a = next.find((n) => n.id === 'a')!
    expect(a.position).toEqual({ x: 1000, y: 2000 })
    expect(a.width).toBe(1600)
    expect(a.height).toBe(900)
    expect(a.data.premaxRect).toBeUndefined()
  })

  it('leaves an existing premaxRect alone — a maximized node snapped to a zone still restores', () => {
    const maxed = maximizeNodeToRect([term('a', { x: 40, y: 60 })], 'a', RECT)
    const zoned = placeNodeInRect(maxed, 'a', { x: 0, y: 0, width: 700, height: 900 })
    expect(zoned[0].data.premaxRect).toEqual({ x: 40, y: 60, width: 320, height: 240 })
    const restored = restoreMaximizedNode(zoned, 'a')
    expect(restored[0].position).toEqual({ x: 40, y: 60 })
    expect(restored[0].width).toBe(320)
  })

  it('re-fits the frame around a grouped node, absolute rect honoured', () => {
    const g = group('g', { x: 100, y: 100 })
    const child = term('a', { x: 50, y: 80 }, { width: 320, height: 240 }, { parentId: 'g', extent: 'parent' })
    const next = placeNodeInRect([g, child], 'a', RECT)
    const a = next.find((n) => n.id === 'a')!
    const frame = next.find((n) => n.id === 'g')!
    expect(frame.position.x + a.position.x).toBeCloseTo(RECT.x)
    expect(frame.position.y + a.position.y).toBeCloseTo(RECT.y)
    expect((frame.width as number)!).toBeGreaterThanOrEqual(RECT.width)
  })

  it('refuses group frames, collapsed nodes and unknown ids', () => {
    const collapsed = term('c', { x: 0, y: 0 })
    collapsed.data = { ...collapsed.data, collapsed: true }
    expect(placeNodeInRect([group('g', { x: 0, y: 0 })], 'g', RECT)[0].width).toBe(600)
    expect(placeNodeInRect([collapsed], 'c', RECT)[0].width).toBe(320)
    expect(placeNodeInRect([term('a', { x: 1, y: 2 })], 'nope', RECT)).toEqual([term('a', { x: 1, y: 2 })])
  })
})
