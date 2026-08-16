import { describe, it, expect } from 'vitest'
import { normalizeAddress, searchOrUrl } from './browserUrl'

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

describe('searchOrUrl', () => {
  it('passes http(s) URLs through', () => {
    expect(searchOrUrl('https://x.com')).toBe('https://x.com/')
    expect(searchOrUrl('http://a.dev/p')).toBe('http://a.dev/p')
  })
  it('treats a bare host as https', () => {
    expect(searchOrUrl('github.com/a')).toBe('https://github.com/a')
    expect(searchOrUrl('example.com')).toBe('https://example.com/')
  })
  it('treats localhost / 127.0.0.1 as http (dev servers)', () => {
    expect(searchOrUrl('localhost:3000')).toBe('http://localhost:3000/')
    expect(searchOrUrl('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x')
  })
  it('Google-searches free text and non-http schemes', () => {
    expect(searchOrUrl('how to code')).toBe('https://www.google.com/search?q=how%20to%20code')
    expect(searchOrUrl('weather')).toBe('https://www.google.com/search?q=weather')
    expect(searchOrUrl('javascript:alert(1)')).toBe('https://www.google.com/search?q=javascript%3Aalert(1)')
    expect(searchOrUrl('data:text/html,x')).toBe('https://www.google.com/search?q=data%3Atext%2Fhtml%2Cx')
  })
  it('navigates file:// URLs to local files', () => {
    expect(searchOrUrl('file:///home/me/page.html')).toBe('file:///home/me/page.html')
  })
  it('folds a mistyped file host into the path (file://path/… → file:///path/…)', () => {
    expect(searchOrUrl('file://path/to/my/file.html')).toBe('file:///path/to/my/file.html')
    expect(searchOrUrl('file://localhost/x.html')).toBe('file:///x.html')
  })
  it('returns null for empty', () => {
    expect(searchOrUrl('   ')).toBeNull()
  })
})
