import { describe, it, expect } from 'vitest'
import { normalizeAddress } from './browserUrl'

describe('normalizeAddress', () => {
  it('passes http(s) URLs through (normalized)', () => {
    expect(normalizeAddress('https://example.com')).toBe('https://example.com/')
    expect(normalizeAddress('http://a.dev/x')).toBe('http://a.dev/x')
  })
  it('prepends https:// to a bare host', () => {
    expect(normalizeAddress('example.com')).toBe('https://example.com/')
    expect(normalizeAddress('  news.ycombinator.com  ')).toBe('https://news.ycombinator.com/')
  })
  it('rejects non-http schemes and junk', () => {
    expect(normalizeAddress('file:///etc/passwd')).toBeNull()
    expect(normalizeAddress('javascript:alert(1)')).toBeNull()
    expect(normalizeAddress('data:text/html,x')).toBeNull()
    expect(normalizeAddress('not a url')).toBeNull()
    expect(normalizeAddress('')).toBeNull()
  })
})
