import { describe, it, expect } from 'vitest'
import { allowGuestNavigation } from './webview-nav'

describe('allowGuestNavigation', () => {
  it('allows http(s) from anywhere', () => {
    expect(allowGuestNavigation('https://a.com/', 'https://b.com/')).toBe(true)
    expect(allowGuestNavigation('file:///home/me/x.html', 'http://localhost:3000/')).toBe(true)
    expect(allowGuestNavigation('', 'https://a.com/')).toBe(true)
  })
  it('allows nt-media:// from anywhere', () => {
    expect(allowGuestNavigation('https://a.com/', 'nt-media://abc/video.mp4')).toBe(true)
  })
  it('allows file:// only from a local page or a fresh guest', () => {
    expect(allowGuestNavigation('file:///home/me/index.html', 'file:///home/me/other.html')).toBe(true)
    expect(allowGuestNavigation('', 'file:///home/me/index.html')).toBe(true)
    expect(allowGuestNavigation('about:blank', 'file:///home/me/index.html')).toBe(true)
  })
  it('blocks file:// from a remote page', () => {
    expect(allowGuestNavigation('https://evil.com/', 'file:///etc/passwd')).toBe(false)
  })
  it('blocks other schemes from anywhere', () => {
    expect(allowGuestNavigation('https://a.com/', 'javascript:alert(1)')).toBe(false)
    expect(allowGuestNavigation('file:///home/me/x.html', 'javascript:alert(1)')).toBe(false)
    expect(allowGuestNavigation('https://a.com/', 'data:text/html,x')).toBe(false)
    expect(allowGuestNavigation('https://a.com/', 'smb://server/share')).toBe(false)
  })
})
