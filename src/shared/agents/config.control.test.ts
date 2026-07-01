import { describe, it, expect } from 'vitest'
import { canControlCanvas } from './config'

describe('canControlCanvas', () => {
  it('is true for claude only', () => {
    expect(canControlCanvas('claude')).toBe(true)
    expect(canControlCanvas('codex')).toBe(false)
    expect(canControlCanvas('gemini')).toBe(false)
    expect(canControlCanvas('custom:abc')).toBe(false)
  })
})
