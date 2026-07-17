import { describe, expect, it } from 'vitest'
import { concatChunks } from './pcm-capture'

describe('concatChunks', () => {
  it('concatenates in order', () => {
    const out = concatChunks([new Float32Array([1, 2]), new Float32Array([3])])
    expect(Array.from(out)).toEqual([1, 2, 3])
  })
  it('handles empty input', () => {
    expect(concatChunks([]).length).toBe(0)
  })
})
