import { describe, it, expect } from 'vitest'
import { resolveMediaPath, mediaUrlFor } from './media-protocol'

describe('resolveMediaPath (path jail)', () => {
  const allow = new Set(['/projects/app/clip.mp4', '/projects/app/out.html'])

  it('returns the absolute path for an allowed file', () => {
    const url = mediaUrlFor('/projects/app/clip.mp4')
    expect(resolveMediaPath(new URL(url).pathname, allow)).toBe('/projects/app/clip.mp4')
  })

  it('rejects a path not on the allowlist', () => {
    const url = mediaUrlFor('/etc/passwd')
    expect(resolveMediaPath(new URL(url).pathname, allow)).toBeNull()
  })

  it('rejects traversal that escapes an allowed file', () => {
    expect(resolveMediaPath('/projects/app/../../etc/passwd', allow)).toBeNull()
  })

  it('round-trips paths with spaces/unicode via mediaUrlFor', () => {
    const allow2 = new Set(['/a b/çlip.mp4'])
    const url = mediaUrlFor('/a b/çlip.mp4')
    expect(resolveMediaPath(new URL(url).pathname, allow2)).toBe('/a b/çlip.mp4')
  })

  it('round-trips a path containing ? through mediaUrlFor', () => {
    const original = '/projects/app/q?x&y#z.mp4'
    const allow3 = new Set([original])
    const url = mediaUrlFor(original)
    expect(resolveMediaPath(new URL(url).pathname, allow3)).toBe(original)
  })
})
