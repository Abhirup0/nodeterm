import { describe, it, expect } from 'vitest'
import { canControlCanvas } from './config'

describe('canControlCanvas', () => {
  it('is true for the three builtins, not custom agents', () => {
    expect(canControlCanvas('claude')).toBe(true)
    expect(canControlCanvas('codex')).toBe(true)
    expect(canControlCanvas('gemini')).toBe(true)
    expect(canControlCanvas('custom:abc')).toBe(false)
  })
})
