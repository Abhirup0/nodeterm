import { describe, expect, it } from 'vitest'
import { parseOsc52 } from './osc52'

describe('parseOsc52', () => {
  it('decodes a base64 clipboard write payload', () => {
    expect(parseOsc52('c;' + btoa('Hello, world'))).toBe('Hello, world')
  })
  it('ignores a read query (?)', () => {
    expect(parseOsc52('c;?')).toBeNull()
  })
  it('ignores empty / malformed / no-semicolon', () => {
    expect(parseOsc52('c;')).toBeNull()
    expect(parseOsc52('garbage')).toBeNull()
    expect(parseOsc52('c;not_base64!!')).toBeNull()
  })
  it('ignores an oversized payload', () => {
    expect(parseOsc52('c;' + 'A'.repeat(1_000_001))).toBeNull()
  })
})
