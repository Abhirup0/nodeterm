import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createCanvasPublisher,
  isEphemeralNodeId,
  publishableStates,
  PUBLISH_INTERVAL_MS
} from './canvas-publish'
import type { CanvasMutation, CanvasNodeState } from './types'

const node = (id: string, x = 0): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    title: 't',
    color: '#fff',
    position: { x, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNodeState

function collect() {
  const sent: CanvasMutation[] = []
  return { sent, send: (m: CanvasMutation) => sent.push(m) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createCanvasPublisher', () => {
  it('publishes the diff against the last snapshot (add, move, remove)', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')])
    p.publish([node('a', 5)])
    p.publish([])
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a') },
      { op: 'upsert', node: node('a', 5) },
      { op: 'remove', id: 'a' }
    ])
  })

  it('publishes nothing when the snapshot is unchanged', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')])
    p.publish([node('a')])
    expect(c.sent).toHaveLength(1)
  })

  it('throttles drag frames to ~20 Hz: leading send, one trailing send per interval', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    // 5 drag frames inside one interval → 1 leading send, the rest coalesced.
    for (let x = 1; x <= 5; x++) p.publish([node('a', x)], { throttle: true })
    expect(c.sent).toEqual([{ op: 'upsert', node: node('a', 1) }])
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS)
    // The trailing send carries the LATEST position, not the intermediate ones.
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a', 1) },
      { op: 'upsert', node: node('a', 5) }
    ])
  })

  it('an unthrottled publish (drag settle) sends immediately and cancels the pending frame', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    p.publish([node('a', 1)], { throttle: true })
    p.publish([node('a', 2)], { throttle: true })
    p.publish([node('a', 9)]) // settle
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 4)
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a', 1) },
      { op: 'upsert', node: node('a', 9) }
    ])
  })

  it('flush() sends a coalesced drag frame right away', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    p.publish([node('a', 1)], { throttle: true })
    p.publish([node('a', 2)], { throttle: true })
    p.flush()
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a', 1) },
      { op: 'upsert', node: node('a', 2) }
    ])
  })

  // THE LOOP GUARD: a snapshot that arrived FROM a peer is adopted, never re-published.
  it('adopt() takes a snapshot as baseline without sending — no infinite echo', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')])
    c.sent.length = 0
    // A peer's mutation lands: Canvas applies it and adopts the result.
    const afterPeer = [node('a'), node('b', 3)]
    p.adopt(afterPeer)
    expect(c.sent).toEqual([])
    // The React effect then fires with exactly that snapshot → the diff is empty → nothing is sent.
    p.publish(afterPeer)
    expect(c.sent).toEqual([])
    // A genuinely local change afterwards still publishes (and only the delta).
    p.publish([node('a'), node('b', 8)])
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 8) }])
  })

  it('dispose() drops a pending drag frame', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    p.publish([node('a', 1)], { throttle: true })
    p.publish([node('a', 2)], { throttle: true })
    p.dispose()
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 4)
    expect(c.sent).toEqual([{ op: 'upsert', node: node('a', 1) }])
  })
})

describe('ephemeral nodes are never published', () => {
  it('isEphemeralNodeId matches subagent cards (by id set) and loop cards (by prefix)', () => {
    const eph = new Set(['sub-123'])
    expect(isEphemeralNodeId('sub-123', eph)).toBe(true)
    expect(isEphemeralNodeId('loop-n1', eph)).toBe(true)
    expect(isEphemeralNodeId('n1', eph)).toBe(false)
  })

  it('publishableStates strips them, so no mutation is ever emitted for one', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send)
    const eph = new Set(['sub-123'])
    const states = [node('n1'), node('sub-123'), node('loop-n1')]
    expect(publishableStates(states, eph).map((n) => n.id)).toEqual(['n1'])
    p.publish(publishableStates(states, eph))
    expect(c.sent).toEqual([{ op: 'upsert', node: node('n1') }])
    // Moving an ephemeral card produces NO mutation at all.
    const moved = [node('n1'), node('sub-123', 99), node('loop-n1', 99)]
    p.publish(publishableStates(moved, eph))
    expect(c.sent).toHaveLength(1)
  })
})
