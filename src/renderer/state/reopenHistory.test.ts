import { describe, it, expect } from 'vitest'
import { pushEntry, popEntry, HISTORY_CAP, type ReopenEntry } from './reopenHistory'

const proj = (id: string, closedAt: number): ReopenEntry => ({ kind: 'project', projectId: id, closedAt })

describe('pushEntry', () => {
  it('appends to the end (most recent last)', () => {
    const out = pushEntry([proj('a', 1)], proj('b', 2), 10)
    expect(out.map((e) => (e as { projectId: string }).projectId)).toEqual(['a', 'b'])
  })

  it('caps the stack, dropping the OLDEST entries', () => {
    const stack = [proj('a', 1), proj('b', 2)]
    const out = pushEntry(stack, proj('c', 3), 2)
    expect(out.map((e) => (e as { projectId: string }).projectId)).toEqual(['b', 'c'])
  })

  it('HISTORY_CAP is 10', () => {
    expect(HISTORY_CAP).toBe(10)
  })
})

describe('popEntry', () => {
  it('removes and returns the LAST (most recent) entry', () => {
    const stack = [proj('a', 1), proj('b', 2)]
    const { entry, rest } = popEntry(stack)
    expect(entry).toEqual(proj('b', 2))
    expect(rest).toEqual([proj('a', 1)])
  })

  it('returns undefined entry and an empty rest for an empty stack', () => {
    const { entry, rest } = popEntry([])
    expect(entry).toBeUndefined()
    expect(rest).toEqual([])
  })
})
