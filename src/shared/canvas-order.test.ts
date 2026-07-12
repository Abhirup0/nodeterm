// The ordering state — the client half of the convergence contract (the other half is the
// reflector's `seq`). The end-to-end proof lives in src/core/canvas-sync.convergence.test.ts
// (two clients, async bus); this pins the rules one at a time.

import { describe, it, expect } from 'vitest'
import {
  createCanvasOrder,
  createReconnectWatch,
  mutationNodeId,
  PENDING_TTL_MS
} from './canvas-order'
import type { CanvasMutation, CanvasNodeState } from './types'

const node = (id: string, x = 0): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    title: 't',
    color: '#fff',
    group: null,
    position: { x, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNodeState

const up = (id: string, x: number, src: string | undefined, seq: number): CanvasMutation => ({
  op: 'upsert',
  node: node(id, x),
  ...(src ? { src } : {}),
  seq
})
const rm = (id: string, src: string | undefined, seq: number): CanvasMutation => ({
  op: 'remove',
  id,
  ...(src ? { src } : {}),
  seq
})

describe('mutationNodeId', () => {
  it('is the node a mutation addresses, whichever op', () => {
    expect(mutationNodeId(up('n1', 0, 'x', 1))).toBe('n1')
    expect(mutationNodeId(rm('n2', 'x', 1))).toBe('n2')
  })
})

describe('createCanvasOrder', () => {
  it('applies a peer mutation', () => {
    const o = createCanvasOrder('me')
    expect(o.accept(up('n1', 5, 'peer', 1))).toBe(true)
  })

  // Rule 1. Our own mutation comes back stamped (the reflector echoes to the sender — that echo is
  // the ack). It must NOT be re-applied: we applied it optimistically, and by the time it returns
  // the user may already have dragged the node further — re-applying would rubber-band it.
  it('never re-applies our own echo (it is an ack, not an edit)', () => {
    const o = createCanvasOrder('me')
    const mine = up('n1', 10, 'me', 1)
    o.onLocal(mine)
    expect(o.accept(mine)).toBe(false)
  })

  // Rule 2. While one of OUR mutations for a node is unacked, a peer's mutation for that node is
  // necessarily EARLIER in the total order (FIFO: had the reflector ordered ours first, our ack
  // would already be here). Ours will therefore win on every other client — so we keep ours.
  it('a peer mutation loses to an unacked local edit of the same node', () => {
    const o = createCanvasOrder('me')
    o.onLocal(up('n1', 200, 'me', 0)) // cast, not yet acked
    expect(o.accept(up('n1', 100, 'peer', 7))).toBe(false) // peer's edit: dropped, ours wins
    expect(o.accept(up('n1', 100, 'me', 8))).toBe(false) // …our ack arrives
    expect(o.accept(up('n1', 300, 'peer', 9))).toBe(true) // …and now peers land again
  })

  it('does not let one node\'s pending edit suppress another node', () => {
    const o = createCanvasOrder('me')
    o.onLocal(up('n1', 1, 'me', 0))
    expect(o.accept(up('n2', 1, 'peer', 4))).toBe(true)
  })

  it('counts pending edits per node (a drag casts many frames before the first ack)', () => {
    const o = createCanvasOrder('me')
    o.onLocal(up('n1', 1, 'me', 0))
    o.onLocal(up('n1', 2, 'me', 0))
    expect(o.accept(up('n1', 9, 'peer', 5))).toBe(false)
    expect(o.accept(up('n1', 1, 'me', 6))).toBe(false) // ack 1 of 2 — still one frame in flight
    expect(o.accept(up('n1', 9, 'peer', 7))).toBe(false)
    expect(o.accept(up('n1', 2, 'me', 8))).toBe(false) // ack 2 of 2
    expect(o.accept(up('n1', 9, 'peer', 9))).toBe(true)
  })

  // Deliveries are FIFO per connection, but a client applies mutations from SEVERAL senders, so a
  // straggler can still arrive after a newer mutation for the same node has landed (e.g. it was
  // held while one of ours was pending). Applying it would drag the node backwards out of the order.
  it('drops a mutation the total order has already superseded', () => {
    const o = createCanvasOrder('me')
    expect(o.accept(up('n1', 10, 'peer', 5))).toBe(true)
    expect(o.accept(up('n1', 99, 'other', 3))).toBe(false) // older seq → superseded
    expect(o.accept(up('n1', 99, 'other', 5))).toBe(false) // same seq → duplicate
    expect(o.accept(up('n1', 99, 'other', 6))).toBe(true) // newer → wins
  })

  it('a remove and an upsert of one node share the order (a remove is not special-cased)', () => {
    const o = createCanvasOrder('me')
    expect(o.accept(rm('n1', 'peer', 4))).toBe(true)
    expect(o.accept(up('n1', 1, 'peer', 3))).toBe(false) // an older upsert cannot resurrect it
    expect(o.accept(up('n1', 1, 'other', 5))).toBe(true) // a NEWER one can (that is undo-of-delete)
  })

  // The pending gate assumes the ack always comes back. It usually does — but an ack can be LATE
  // (our socket carries pty output too), and unbounded suppression would deafen the node to its
  // peers for the rest of the session.
  it('an ack that never arrives expires — a lost cast cannot deafen a node forever', () => {
    let t = 1000
    const o = createCanvasOrder('me', { now: () => t })
    o.onLocal(up('n1', 1, 'me', 0)) // cast… and no ack comes back
    expect(o.accept(up('n1', 5, 'peer', 2))).toBe(false)
    t += PENDING_TTL_MS + 1
    expect(o.accept(up('n1', 6, 'peer', 3))).toBe(true)
  })

  // Rule 3. Expiring the suppression let a peer overwrite an optimistic value we are still waiting
  // to have acked. Our echo is then the only copy of a value that WON on every other client — so it
  // repairs the node instead of being dropped as an ack. Without this, this client sat on the
  // losing value forever and wrote it to disk over everyone else's canvas.
  it('a late ack REPAIRS a node a peer overwrote after the TTL lapsed', () => {
    let t = 1000
    const o = createCanvasOrder('me', { now: () => t })
    o.onLocal(up('n1', 100, 'me', 0)) // cast; the reflector ordered it 7th — it wins everywhere
    t += PENDING_TTL_MS + 1 // our ack is stuck behind a backed-up socket
    expect(o.accept(up('n1', 50, 'peer', 6))).toBe(true) // …so the peer's OLDER edit lands on us
    expect(o.accept(up('n1', 100, 'me', 7))).toBe(true) // …and our late ack puts our value back
    // Settled: the node listens to peers again, and later echoes are ordinary acks once more.
    expect(o.accept(up('n1', 20, 'peer', 8))).toBe(true)
  })

  it('a late ack that LOST the total order is still just an ack (no rubber-band)', () => {
    let t = 1000
    const o = createCanvasOrder('me', { now: () => t })
    o.onLocal(up('n1', 100, 'me', 0)) // ordered 6th — the peer's edit is ordered AFTER it
    t += PENDING_TTL_MS + 1
    expect(o.accept(up('n1', 50, 'peer', 7))).toBe(true) // the peer's edit wins everywhere…
    expect(o.accept(up('n1', 100, 'me', 6))).toBe(false) // …so our echo is superseded: dropped
  })

  it('a fresh local edit re-arms the node, so an older echo of ours cannot replay over it', () => {
    let t = 1000
    const o = createCanvasOrder('me', { now: () => t })
    o.onLocal(up('n1', 100, 'me', 0))
    t += PENDING_TTL_MS + 1
    expect(o.accept(up('n1', 50, 'peer', 6))).toBe(true) // peer overwrote our optimistic value…
    o.onLocal(up('n1', 300, 'me', 0)) // …but the user drags it again: 300 is on our canvas now
    expect(o.accept(up('n1', 100, 'me', 7))).toBe(false) // the old echo must not rubber-band it
    expect(o.accept(up('n1', 300, 'me', 8))).toBe(false) // our new cast's echo is a plain ack
  })

  // A drag emits a frame every 50 ms. Dating the pending entry from the OLDEST unacked cast expired
  // it mid-drag, and a peer's older frame then rubber-banded a node the user was still holding.
  it('a continuous drag keeps its own suppression alive past the TTL', () => {
    let t = 1000
    const o = createCanvasOrder('me', { now: () => t })
    for (let i = 0; i < 200; i++) {
      o.onLocal(up('n1', i, 'me', 0)) // 200 frames × 50 ms = 10 s of dragging, all acked promptly
      expect(o.accept(up('n1', i, 'me', i + 1))).toBe(false)
      t += 50
    }
    o.onLocal(up('n1', 999, 'me', 0)) // still dragging, this frame not yet acked
    expect(o.accept(up('n1', 5, 'peer', 500))).toBe(false) // …a peer's frame still loses to ours
  })

  it('an unstamped mutation (no reflector in the path) is never treated as stale', () => {
    const o = createCanvasOrder('me')
    const unstamped: CanvasMutation = { op: 'upsert', node: node('n1', 1) }
    expect(o.accept(unstamped)).toBe(true)
    expect(o.accept(unstamped)).toBe(true)
  })

  it('reset forgets the order and the pending edits (project switch / reconnect)', () => {
    const o = createCanvasOrder('me')
    o.onLocal(up('n1', 1, 'me', 0))
    expect(o.accept(up('n1', 5, 'peer', 9))).toBe(false)
    o.reset()
    expect(o.accept(up('n1', 5, 'peer', 1))).toBe(true) // pending gone AND the seq floor gone
  })
})

// WHEN to call reset(). It exists for ONE reason — a core restart puts `seq` back at 0 while our
// `seen` map still holds the old (high) values, and we would then drop every new mutation as a
// straggler — and it is EXPENSIVE to call when that reason does not hold: it drops `pending` and
// `superseded`, i.e. the in-flight casts whose late echo is the only thing that can repair a node a
// peer overwrote. So it must fire on a genuine reconnect and NOWHERE else.
describe('createReconnectWatch', () => {
  it('does not reset on the first hello (null → myId): there is no older connection to forget', () => {
    const w = createReconnectWatch(null)
    expect(w(null)).toBe(false) // still no id (presence has not answered yet)
    expect(w('cl-1')).toBe(false) // our FIRST clientId — nothing was ever seen from an older core
    expect(w('cl-1')).toBe(false) // idle presence updates (a peer's cursor) are not reconnects
  })

  it('resets when a NEW clientId replaces an old one (a genuine reconnect)', () => {
    const w = createReconnectWatch(null)
    expect(w('cl-1')).toBe(false)
    expect(w('cl-2')).toBe(true) // reconnected: the core may have restarted with seq back at 0
    expect(w('cl-2')).toBe(false)
  })

  it('survives the null in the middle of a reconnect (id → null → new id still resets)', () => {
    const w = createReconnectWatch('cl-1')
    expect(w(null)).toBe(false) // the socket dropped: keep the state, wait for the new id
    expect(w('cl-1')).toBe(false) // …the SAME connection came back: nothing to forget
    expect(w(null)).toBe(false)
    expect(w('cl-3')).toBe(true) // a different one: reset
  })

  it('an id already known at mount is not a reconnect', () => {
    const w = createReconnectWatch('cl-1')
    expect(w('cl-1')).toBe(false)
  })

  // The desktop presence hub's clientId is a NUMBER (the Electron sender id) — and 0 is a perfectly
  // real connection, so only `null` may mean "no id yet".
  it('treats a numeric clientId of 0 as a real connection, not as "not resolved yet"', () => {
    const w = createReconnectWatch(null)
    expect(w(0)).toBe(false) // the first hello…
    expect(w(0)).toBe(false)
    expect(w(1)).toBe(true) // …and a genuine reconnect after it
  })
})
