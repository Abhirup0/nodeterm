// The ordering state — the client half of the convergence contract (the other half is the
// reflector's `seq`). The end-to-end proof lives in src/core/canvas-sync.convergence.test.ts
// (two clients, async bus); this pins the rules one at a time.

import { describe, it, expect } from 'vitest'
import { createCanvasOrder, mutationNodeId, PENDING_TTL_MS } from './canvas-order'
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

  // The pending gate assumes the ack always comes back. It usually does — but the reflector drops
  // a mutation it refuses (oversized), and that would otherwise deafen the node to its peers for
  // the rest of the session.
  it('an ack that never arrives expires — a lost cast cannot deafen a node forever', () => {
    let t = 1000
    const o = createCanvasOrder('me', { now: () => t })
    o.onLocal(up('n1', 1, 'me', 0)) // cast… and the reflector refuses it: no ack, ever
    expect(o.accept(up('n1', 5, 'peer', 2))).toBe(false)
    t += PENDING_TTL_MS + 1
    expect(o.accept(up('n1', 6, 'peer', 3))).toBe(true)
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
