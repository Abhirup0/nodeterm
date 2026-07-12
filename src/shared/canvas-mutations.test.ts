import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  applyCanvasMutation,
  createMutationGuard,
  diffToMutations,
  isCanvasMutation,
  MUTATION_MAX_BYTES
} from './canvas-mutations'
import type { CanvasNodeState } from './types'

const n = (id: string, x = 0, title = 't'): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    title,
    color: '#fff',
    position: { x, y: 0 },
    size: { width: 100, height: 100 }
  }) as CanvasNodeState

describe('applyCanvasMutation', () => {
  it('upserts by id (append when absent, replace when present) without mutating the input', () => {
    const a = [n('1')]
    expect(applyCanvasMutation(a, { op: 'upsert', node: n('2') }).map((x) => x.id)).toEqual([
      '1',
      '2'
    ])
    expect(applyCanvasMutation(a, { op: 'upsert', node: n('1', 9) })[0].position.x).toBe(9)
    expect(a[0].position.x).toBe(0)
  })

  it('removes by id', () => {
    expect(
      applyCanvasMutation([n('1'), n('2')], { op: 'remove', id: '1' }).map((x) => x.id)
    ).toEqual(['2'])
  })
})

describe('diffToMutations', () => {
  it('emits an upsert for added and changed nodes and a remove for dropped ones', () => {
    expect(diffToMutations([n('1')], [n('1', 5)])).toEqual([{ op: 'upsert', node: n('1', 5) }])
    expect(diffToMutations([n('1')], [n('1'), n('2')])).toEqual([{ op: 'upsert', node: n('2') }])
    expect(diffToMutations([n('1'), n('2')], [n('1')])).toEqual([{ op: 'remove', id: '2' }])
  })

  it('emits nothing when the snapshots are deep-equal regardless of key order', () => {
    const a = {
      id: '1',
      kind: 'terminal',
      position: { x: 1, y: 2 },
      size: { width: 3, height: 4 }
    } as CanvasNodeState
    const b = {
      size: { height: 4, width: 3 },
      position: { y: 2, x: 1 },
      kind: 'terminal',
      id: '1'
    } as CanvasNodeState
    expect(diffToMutations([a], [b])).toEqual([])
  })

  it('detects a title/color/collapsed change, not just geometry', () => {
    expect(diffToMutations([n('1')], [n('1', 0, 'renamed')])).toEqual([
      { op: 'upsert', node: n('1', 0, 'renamed') }
    ])
  })
})

// The publisher's guard: the same verdict as `isCanvasMutation`, but it must not PAY for it twice on
// an unchanged node. The size check serializes the whole node, the publisher re-emits a refused node
// on every publish (that is what makes it sync the moment the user trims it), and a drag publishes at
// 20 Hz — so the one node that is already pathological (a sticky holding a pasted document) was being
// stringified 20×/s, at a cost proportional to its size.
describe('createMutationGuard', () => {
  afterEach(() => vi.restoreAllMocks())

  /** A sticky over the size cap. `text` is the SAME string on every rebuild — exactly what
   *  flowToNodeStates does: it rebuilds the node object each publish but passes `data.text` through
   *  by reference. */
  const bigText = 'x'.repeat(MUTATION_MAX_BYTES)
  const fat = (x = 0, text = bigText): CanvasNodeState =>
    ({ ...n('sticky-1', x), kind: 'sticky', text }) as CanvasNodeState

  /** Count only the serializations of a NODE (the expensive path) — not vitest's own internals. */
  const countSerializations = (): { calls: () => number } => {
    const spy = vi.spyOn(JSON, 'stringify')
    return {
      calls: () =>
        spy.mock.calls.filter((c) => {
          const v = c[0] as { node?: { id?: unknown } } | undefined
          return !!v && typeof v === 'object' && !!v.node
        }).length
    }
  }

  it('serializes an unchanged oversized node ONCE, however many times it is re-published', () => {
    const guard = createMutationGuard()
    const { calls } = countSerializations()

    // 40 publishes of the SAME (still oversized) sticky — two seconds of a 20 Hz drag.
    for (let i = 0; i < 40; i++) {
      expect(guard({ op: 'upsert', node: fat(), src: 'me' })).toBe(false)
    }
    expect(calls()).toBe(1) // was: 40 — one full serialization of a 256 KB node per publish
  })

  it('re-validates the moment the node actually changes (and the trimmed sticky syncs)', () => {
    const guard = createMutationGuard()
    expect(guard({ op: 'upsert', node: fat() })).toBe(false)

    // Still too big, but MOVED: a changed node is a new verdict, so it is paid for again…
    const { calls } = countSerializations()
    expect(guard({ op: 'upsert', node: fat(7) })).toBe(false)
    expect(calls()).toBe(1)

    // …and the user trims it → it is within the cap → it CASTS. (The refusal must not be sticky:
    // the whole point of retrying a refused node is that it syncs as soon as it fits.)
    expect(guard({ op: 'upsert', node: fat(7, 'short') })).toBe(true)
    // …and stays castable afterwards, without re-consulting a stale refusal.
    expect(guard({ op: 'upsert', node: fat(7, 'short') })).toBe(true)
  })

  it('gives exactly the verdict of isCanvasMutation (shape, ids, geometry, size)', () => {
    const guard = createMutationGuard()
    const cases: unknown[] = [
      { op: 'upsert', node: n('1') },
      { op: 'remove', id: '1' },
      { op: 'remove', id: '' },
      { op: 'upsert', node: { ...n('1'), id: '' } },
      { op: 'upsert', node: { ...n('1'), position: { x: NaN, y: 0 } } },
      { op: 'upsert', node: fat() },
      { op: 'nope' },
      null
    ]
    for (const c of cases) {
      expect(guard(c as never), JSON.stringify(c).slice(0, 40)).toBe(isCanvasMutation(c))
    }
  })

  it('remembers a refusal per node — one fat sticky does not mask another', () => {
    const guard = createMutationGuard()
    const other = (): CanvasNodeState =>
      ({ ...n('sticky-2'), kind: 'sticky', text: bigText }) as CanvasNodeState
    expect(guard({ op: 'upsert', node: fat() })).toBe(false)
    expect(guard({ op: 'upsert', node: other() })).toBe(false)
    const { calls } = countSerializations()
    expect(guard({ op: 'upsert', node: fat() })).toBe(false)
    expect(guard({ op: 'upsert', node: other() })).toBe(false)
    expect(calls()).toBe(0) // both refusals are remembered, neither is re-serialized
  })
})
