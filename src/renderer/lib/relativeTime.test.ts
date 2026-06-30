import { describe, expect, it } from 'vitest'
import { relativeTime } from './relativeTime'

const NOW = 1_000_000_000_000

describe('relativeTime', () => {
  it('formats recent + past spans', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now')
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago')
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago')
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2d ago')
  })
})
