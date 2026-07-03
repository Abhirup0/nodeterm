import { describe, it, expect } from 'vitest'
import { addEntry, type HistoryEntry } from './browserHistory'

const e = (url: string, ts: number): HistoryEntry => ({ url, title: url, ts })

describe('addEntry', () => {
  it('prepends the newest entry', () => {
    const out = addEntry([e('a', 1)], e('b', 2), 10)
    expect(out.map((x) => x.url)).toEqual(['b', 'a'])
  })
  it('dedups by url, bumping a revisit to the top', () => {
    const out = addEntry([e('a', 1), e('b', 2)], e('a', 3), 10)
    expect(out.map((x) => x.url)).toEqual(['a', 'b'])
    expect(out[0].ts).toBe(3)
  })
  it('enforces the cap (drops the oldest)', () => {
    const out = addEntry([e('a', 1), e('b', 2)], e('c', 3), 2)
    expect(out.map((x) => x.url)).toEqual(['c', 'a'])
  })
})
