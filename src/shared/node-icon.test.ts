import { describe, expect, it } from 'vitest'
import {
  nodeIconMime,
  normalizeNodeIcon,
  portableIconPath,
  resolveIconPath
} from './node-icon'

// The value under test arrives from `.nodeterm/project.json` — git-shared, hand-editable, and on
// an SSH project a file on someone else's host. Every case below is a thing that file can say.
describe('normalizeNodeIcon', () => {
  it('keeps a single emoji', () => {
    expect(normalizeNodeIcon({ type: 'emoji', value: 'rocket'.length ? '\u{1F680}' : '' })).toEqual({
      type: 'emoji',
      value: '\u{1F680}'
    })
  })

  it('keeps a ZWJ sequence whole', () => {
    // 11 UTF-16 units. A naive length cap would reject it; a naive slice would cut it into a
    // fragment that renders as two lone people. Neither is acceptable.
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'
    expect(normalizeNodeIcon({ type: 'emoji', value: family })).toEqual({
      type: 'emoji',
      value: family
    })
  })

  it('truncates a multi-character value to its first grapheme', () => {
    expect(normalizeNodeIcon({ type: 'emoji', value: 'abc' })).toEqual({ type: 'emoji', value: 'a' })
  })

  it('caps a blob from a shared file instead of rendering it into every surface', () => {
    const blob = '\u{1F680}'.repeat(5000)
    const out = normalizeNodeIcon({ type: 'emoji', value: blob })
    expect(out).toEqual({ type: 'emoji', value: '\u{1F680}' })
  })

  it('strips control characters rather than letting a paste carry them into a header', () => {
    const withNewline = `${String.fromCharCode(10)}${String.fromCharCode(7)}\u{1F41B}`
    expect(normalizeNodeIcon({ type: 'emoji', value: withNewline })).toEqual({
      type: 'emoji',
      value: '\u{1F41B}'
    })
  })

  it('refuses an emoji that is only whitespace or control characters', () => {
    expect(normalizeNodeIcon({ type: 'emoji', value: '   ' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'emoji', value: String.fromCharCode(9) })).toBeUndefined()
  })

  it('refuses shapes that are not an icon at all', () => {
    expect(normalizeNodeIcon(undefined)).toBeUndefined()
    expect(normalizeNodeIcon(null)).toBeUndefined()
    expect(normalizeNodeIcon('\u{1F680}')).toBeUndefined()
    expect(normalizeNodeIcon(42)).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'svg', markup: '<script/>' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'emoji', value: 7 })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: 7 })).toBeUndefined()
  })

  it('keeps an absolute image path with a known extension', () => {
    expect(normalizeNodeIcon({ type: 'image', path: '/tmp/a/logo.PNG' })).toEqual({
      type: 'image',
      path: '/tmp/a/logo.PNG'
    })
  })

  it('keeps a project-relative image path', () => {
    expect(normalizeNodeIcon({ type: 'image', path: './.nodeterm/images/logo.png' })).toEqual({
      type: 'image',
      path: './.nodeterm/images/logo.png'
    })
  })

  // The gate that stops a cloned project.json from aiming fs.readBinary at a private key.
  it('refuses a path that is not an image', () => {
    expect(normalizeNodeIcon({ type: 'image', path: '/home/u/.ssh/id_rsa' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: '/etc/passwd' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: '/home/u/README' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: '/home/u/notes.png.txt' })).toBeUndefined()
  })

  it('refuses a relative path that traverses out of the project', () => {
    expect(normalizeNodeIcon({ type: 'image', path: './../../.ssh/id_rsa.png' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: './a/../../b.png' })).toBeUndefined()
  })

  it('refuses a rootless path, which has nothing to resolve against', () => {
    expect(normalizeNodeIcon({ type: 'image', path: 'logo.png' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: '../logo.png' })).toBeUndefined()
    expect(normalizeNodeIcon({ type: 'image', path: '' })).toBeUndefined()
  })

  it('refuses a path carrying control characters', () => {
    const sneaky = `/tmp/a${String.fromCharCode(0)}.png`
    expect(normalizeNodeIcon({ type: 'image', path: sneaky })).toBeUndefined()
  })
})

describe('nodeIconMime', () => {
  it('maps known extensions case-insensitively', () => {
    expect(nodeIconMime('/a/b.PNG')).toBe('image/png')
    expect(nodeIconMime('/a/b.jpeg')).toBe('image/jpeg')
    expect(nodeIconMime('./x.svg')).toBe('image/svg+xml')
  })

  it('answers undefined for a name with no extension', () => {
    expect(nodeIconMime('/a/README')).toBeUndefined()
    expect(nodeIconMime('/a/.gitignore')).toBeUndefined()
    expect(nodeIconMime('/a/b.key')).toBeUndefined()
  })
})

describe('portableIconPath', () => {
  it('rewrites a path inside the project to ./ form so it travels with the repo', () => {
    expect(portableIconPath('/repo/.nodeterm/images/a.png', '/repo')).toBe(
      './.nodeterm/images/a.png'
    )
    // A trailing slash on the cwd must not produce a doubled separator or a missed match.
    expect(portableIconPath('/repo/.nodeterm/images/a.png', '/repo/')).toBe(
      './.nodeterm/images/a.png'
    )
  })

  it('leaves a path outside the project absolute', () => {
    expect(portableIconPath('/elsewhere/a.png', '/repo')).toBe('/elsewhere/a.png')
    // A sibling directory that merely shares a prefix is NOT inside the project.
    expect(portableIconPath('/repo-two/a.png', '/repo')).toBe('/repo-two/a.png')
  })

  it('leaves everything absolute when the project has no local cwd', () => {
    expect(portableIconPath('/appdata/canvas-images/a.png', undefined)).toBe(
      '/appdata/canvas-images/a.png'
    )
  })
})

describe('resolveIconPath', () => {
  it('resolves a ./ path against the project cwd', () => {
    expect(resolveIconPath('./.nodeterm/images/a.png', '/repo')).toBe('/repo/.nodeterm/images/a.png')
    expect(resolveIconPath('./.nodeterm/images/a.png', '/repo/')).toBe(
      '/repo/.nodeterm/images/a.png'
    )
  })

  it('passes an absolute path through', () => {
    expect(resolveIconPath('/appdata/a.png', '/repo')).toBe('/appdata/a.png')
    expect(resolveIconPath('/appdata/a.png', undefined)).toBe('/appdata/a.png')
  })

  // The icon simply does not draw. It must never fall back to reading something else.
  it('answers undefined for a ./ path on a project with no local cwd', () => {
    expect(resolveIconPath('./.nodeterm/images/a.png', undefined)).toBeUndefined()
  })

  it('answers undefined for a traversing or rootless path', () => {
    expect(resolveIconPath('./../secrets/a.png', '/repo')).toBeUndefined()
    expect(resolveIconPath('a.png', '/repo')).toBeUndefined()
  })
})

// Round-tripping is the property the portability story actually rests on: what we store must be
// what we can read back, for both a project-local and an app-local icon.
describe('portable round trip', () => {
  it('survives store -> normalize -> resolve', () => {
    for (const [abs, cwd] of [
      ['/repo/.nodeterm/images/a.png', '/repo'],
      ['/appdata/canvas-images/b.png', undefined]
    ] as const) {
      const stored = portableIconPath(abs, cwd)
      const icon = normalizeNodeIcon({ type: 'image', path: stored })
      expect(icon).toBeDefined()
      expect(resolveIconPath((icon as { path: string }).path, cwd)).toBe(abs)
    }
  })
})
