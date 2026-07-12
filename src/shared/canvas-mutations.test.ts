import { describe, it, expect } from 'vitest'
import { applyCanvasMutation, diffToMutations } from './canvas-mutations'
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
