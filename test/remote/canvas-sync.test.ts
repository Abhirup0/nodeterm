import { describe, it, expect } from 'vitest'
import { applyMutation, diffToMutations } from '../../src/main/remote/canvas-sync'
const n = (id: string, x = 0) => ({ id, kind: 'terminal', position: { x, y: 0 }, data: {} }) as never
describe('canvas-sync', () => {
  it('upsert adds / replaces by id, immutably', () => {
    const a = [n('1')]
    expect(applyMutation(a, { op: 'upsert', node: n('2') })).toHaveLength(2)
    expect(applyMutation(a, { op: 'upsert', node: n('1', 9) })[0].position.x).toBe(9)
    expect(a[0].position.x).toBe(0)
  })
  it('remove drops by id', () => {
    expect(applyMutation([n('1'), n('2')], { op: 'remove', id: '1' }).map((x) => x.id)).toEqual(['2'])
  })
  it('diffToMutations finds moves and drops', () => {
    expect(diffToMutations([n('1')], [n('1', 5)])).toEqual([{ op: 'upsert', node: n('1', 5) }])
    expect(diffToMutations([n('1'), n('2')], [n('1')])).toEqual([{ op: 'remove', id: '2' }])
    expect(diffToMutations([n('1')], [n('1')])).toEqual([])
  })
})
