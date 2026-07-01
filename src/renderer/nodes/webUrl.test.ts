import { describe, it, expect } from 'vitest'
import { httpUrl } from './webUrl'

describe('httpUrl', () => {
  it('passes http URLs (returns normalized string)', () => {
    expect(httpUrl('http://x')).toBe('http://x/')
  })

  it('passes https URLs (returns normalized string)', () => {
    expect(httpUrl('https://x')).toBe('https://x/')
  })

  it('blocks file: scheme', () => {
    expect(httpUrl('file:///etc/passwd')).toBeNull()
  })

  it('blocks javascript: scheme', () => {
    expect(httpUrl('javascript:alert(1)')).toBeNull()
  })

  it('blocks data: scheme', () => {
    expect(httpUrl('data:text/html,x')).toBeNull()
  })

  it('returns null for garbage input', () => {
    expect(httpUrl('not a url')).toBeNull()
  })
})
