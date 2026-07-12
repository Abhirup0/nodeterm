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
  return {
    sent,
    send: (m: CanvasMutation): void => void sent.push(m) // void: `send` returning false means REFUSED
  }
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

// A cast the reflector would REFUSE (an oversized sticky; a cast with no project active) must not
// be counted as published: it never reaches a peer, and nothing else would ever re-emit it.
describe('a refused cast (send → false)', () => {
  /** Refuses every mutation touching `bad`, records everything it was asked to send. */
  function gate(bad: string) {
    const tried: CanvasMutation[] = []
    const sent: CanvasMutation[] = []
    const send = (m: CanvasMutation): boolean => {
      tried.push(m)
      const id = m.op === 'remove' ? m.id : m.node.id
      if (id === bad) return false
      sent.push(m)
      return true
    }
    return { tried, sent, send }
  }

  it('is retried on the next publish (the baseline does not advance over it)', () => {
    const c = gate('a')
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a')])
    p.publish([node('a', 5)]) // refused: the peers never see it
    expect(c.sent).toEqual([])
    p.publish([node('a', 5)]) // the same snapshot again → still owed, so it is re-emitted
    expect(c.tried).toHaveLength(2)
  })

  it('syncs the moment the edit becomes castable again (the user trims the sticky)', () => {
    let bad = 'a'
    const sent: CanvasMutation[] = []
    const p = createCanvasPublisher((m) => {
      const id = m.op === 'remove' ? m.id : m.node.id
      if (id === bad) return false
      sent.push(m)
      return true
    })
    p.adopt([node('a')])
    p.publish([node('a', 5)]) // oversized → refused
    expect(sent).toEqual([])
    bad = '' // trimmed: it fits now
    p.publish([node('a', 6)])
    expect(sent).toEqual([{ op: 'upsert', node: node('a', 6) }]) // …and it carries the LIVE value
  })

  it('does not hold up the other nodes in the same snapshot', () => {
    const c = gate('a')
    const p = createCanvasPublisher(c.send)
    p.adopt([node('a'), node('b')])
    p.publish([node('a', 5), node('b', 5)])
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 5) }])
    p.publish([node('a', 5), node('b', 5)])
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 5) }]) // b was cast: not re-sent
  })

  it('re-emits a refused ADD as an add, and a refused REMOVE as a remove', () => {
    const c = gate('a')
    const p = createCanvasPublisher(c.send)
    p.publish([node('a')]) // an ADD, refused → not in the baseline
    p.publish([node('a')])
    expect(c.tried).toEqual([
      { op: 'upsert', node: node('a') },
      { op: 'upsert', node: node('a') }
    ])

    const d = gate('z')
    const q = createCanvasPublisher(d.send)
    q.adopt([node('z')])
    q.publish([]) // a REMOVE, refused → the node stays in the baseline
    q.publish([])
    expect(d.tried).toEqual([
      { op: 'remove', id: 'z' },
      { op: 'remove', id: 'z' }
    ])
  })
})

describe('src (the sender tag)', () => {
  // The reflector echoes a mutation back to its sender too — that echo is the ack that carries the
  // total order. `src` is how the sender recognizes it as its own rather than re-applying it.
  it('stamps every emitted mutation with the publisher tag', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send, { src: 'cv-1' })
    p.publish([node('a')])
    p.publish([])
    expect(c.sent).toEqual([
      { op: 'upsert', node: node('a'), src: 'cv-1' },
      { op: 'remove', id: 'a', src: 'cv-1' }
    ])
  })
})

// A solo user must not pay for team sync: diffing stableStringifies every node twice (~1.4 ms at
// 100 nodes) and the `nodes` array changes at 60 Hz during a drag, all to cast into a void.
describe('shouldPublish (the solo gate)', () => {
  it('publishes nothing while no peer is attached', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send, { shouldPublish: () => false })
    p.publish([node('a')])
    p.publish([node('a', 5)], { throttle: true })
    p.flush()
    vi.advanceTimersByTime(PUBLISH_INTERVAL_MS * 4)
    expect(c.sent).toEqual([])
  })

  it('does not even arm the drag throttle timer while solo', () => {
    const c = collect()
    const p = createCanvasPublisher(c.send, { shouldPublish: () => false })
    p.publish([node('a')], { throttle: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the baseline still tracks the canvas: the first edit after a peer joins diffs correctly', () => {
    const c = collect()
    let peers = false
    const p = createCanvasPublisher(c.send, { shouldPublish: () => peers })
    p.publish([node('a'), node('b')]) // solo: nothing sent…
    p.publish([node('a', 7), node('b')]) // …and edits keep updating the baseline
    expect(c.sent).toEqual([])

    peers = true // a teammate opens the canvas
    p.publish([node('a', 7), node('b', 3)])
    // ONLY the node that actually changed — no whole-canvas replay, no stale re-send of `a`.
    expect(c.sent).toEqual([{ op: 'upsert', node: node('b', 3) }])
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
