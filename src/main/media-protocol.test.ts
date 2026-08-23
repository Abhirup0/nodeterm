import { describe, it, expect } from 'vitest'
import { normalize } from 'path'
import { resolveMediaPath, mediaUrlFor, stripDriveSlash } from './media-protocol'

// resolveMediaPath() runs every decoded pathname through node's platform `normalize()` before
// comparing it against the allowlist — on win32 that turns `/a/b` into `\a\b`. The real
// allowlist (allowMediaPath in media-protocol.ts) normalizes on the way in too, so the two
// sides agree in production; here the fixtures build `allow` by hand, so they have to apply
// the same normalization or a Windows run compares `\a\b` against a Set holding `/a/b` and
// every "allowed" case fails as if it were rejected. POSIX is unaffected: normalize() is a
// no-op on these forward-slash-only fixtures there.
const n = (p: string): string => normalize(p)

describe('resolveMediaPath (path jail)', () => {
  const allow = new Set([n('/projects/app/clip.mp4'), n('/projects/app/out.html')])

  it('returns the absolute path for an allowed file', () => {
    const url = mediaUrlFor('/projects/app/clip.mp4', '/')
    expect(resolveMediaPath(new URL(url).pathname, allow)).toBe(n('/projects/app/clip.mp4'))
  })

  it('rejects a path not on the allowlist', () => {
    const url = mediaUrlFor('/etc/passwd', '/')
    expect(resolveMediaPath(new URL(url).pathname, allow)).toBeNull()
  })

  it('rejects traversal that escapes an allowed file', () => {
    expect(resolveMediaPath('/projects/app/../../etc/passwd', allow)).toBeNull()
  })

  it('round-trips paths with spaces/unicode via mediaUrlFor', () => {
    const allow2 = new Set([n('/a b/çlip.mp4')])
    const url = mediaUrlFor('/a b/çlip.mp4', '/')
    expect(resolveMediaPath(new URL(url).pathname, allow2)).toBe(n('/a b/çlip.mp4'))
  })

  it('round-trips a path containing ? through mediaUrlFor', () => {
    const original = '/projects/app/q?x&y#z.mp4'
    const allow3 = new Set([n(original)])
    const url = mediaUrlFor(original, '/')
    expect(resolveMediaPath(new URL(url).pathname, allow3)).toBe(n(original))
  })

  it('preserves a POSIX filename containing a literal backslash', () => {
    const original = String.raw`/projects/app/name\part.png`
    const url = mediaUrlFor(original, '/')
    expect(decodeURIComponent(new URL(url).pathname)).toBe(original)
  })
})

describe('a Windows absolute path round-trips through the URL', () => {
  // The existing cases above all use POSIX paths, which is why this was never caught: on BOTH
  // platforms `normalize()` runs on each side, so `/projects/app/clip.mp4` matches itself. A real
  // `C:\Users\...` path was never put through it. Splitting the pathname on '/' alone left one
  // segment, encoded the backslashes to %5C, and emitted no leading slash — so the drive letter
  // was swallowed into the URL's authority and every image or video opened from a Windows path
  // 404'd out of the jail, looking exactly like a path that had never been allowlisted.
  const WIN = String.raw`C:\Users\me\pics\a.png`

  it('the URL has a real pathname, not a mangled authority', () => {
    const url = new URL(mediaUrlFor(WIN, '\\'))
    expect(url.pathname, 'a drive letter must not end up in the authority').toMatch(/^\/C(:|%3A)\//i)
    expect(url.host).toBe('media')
  })

  it.runIf(process.platform === 'win32')('resolves back to the allowlisted path', () => {
    const allow = new Set([n(WIN)])
    const url = mediaUrlFor(n(WIN), '\\')
    expect(resolveMediaPath(new URL(url).pathname, allow)).toBe(n(WIN))
  })

  it('the leading slash added for a drive letter is stripped back off', () => {
    // Exercises the REAL function. The first version of this test held its own copy of the
    // regex, the copy's escaping was wrong (`[\/]`, forward slash only), and it asserted on
    // '/C:Usersmea.png' — a string that can never occur, since '\U' '\m' '\a' are not JS
    // escapes and the backslashes had silently vanished from the input too. A duplicated
    // pattern proves nothing about the original, and this one was wrong in two ways at once.
    expect(stripDriveSlash('/C:/Users/me/a.png')).toBe('C:/Users/me/a.png')
    expect(stripDriveSlash(String.raw`/C:\Users\me\a.png`)).toBe(String.raw`C:\Users\me\a.png`)
    // A POSIX path must be untouched — stripping its leading slash would make it relative.
    expect(stripDriveSlash('/home/me/a.png')).toBe('/home/me/a.png')
    // Not a drive letter, so not stripped.
    expect(stripDriveSlash('/CC:/x')).toBe('/CC:/x')
    expect(stripDriveSlash('/1:/x')).toBe('/1:/x')
    // No separator after the colon: not a drive root, leave it alone.
    expect(stripDriveSlash('/C:x')).toBe('/C:x')
  })

  it('still refuses a path that is not on the allowlist', () => {
    // The strip must not widen the jail: normalize + the allowlist check still decide.
    const allow = new Set([n(WIN)])
    const evil = mediaUrlFor(String.raw`C:\Users\me\..\..\Windows\System32\config\SAM`, '\\')
    expect(resolveMediaPath(new URL(evil).pathname, allow)).toBeNull()
  })

  it('a segment with URL-reserved characters still round-trips', () => {
    const url = new URL(mediaUrlFor(String.raw`C:\Users\me\a#b?c&d.png`, '\\'))
    expect(decodeURIComponent(url.pathname)).toContain('a#b?c&d.png')
  })
})
