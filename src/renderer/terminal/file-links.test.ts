import { describe, expect, it } from 'vitest'
import { matchFileTokens, resolveFileToken } from './file-links'

describe('matchFileTokens', () => {
  it('finds absolute, dot-relative and bare relative paths', () => {
    const t = matchFileTokens('see /etc/hosts and ./src/a.ts plus src/lib/b.tsx here')
    expect(t.map((x) => x.path)).toEqual(['/etc/hosts', './src/a.ts', 'src/lib/b.tsx'])
    expect(t[0].startIndex).toBe(4)
  })

  it('parses :line and :line:col suffixes into path + line', () => {
    const [t] = matchFileTokens('src/renderer/App.tsx:42:7 - error TS2551')
    expect(t.path).toBe('src/renderer/App.tsx')
    expect(t.line).toBe(42)
    expect(t.text).toBe('src/renderer/App.tsx:42:7')
  })

  it('strips trailing punctuation', () => {
    expect(matchFileTokens('(see src/a.ts, then src/b.ts.)').map((x) => x.path)).toEqual([
      'src/a.ts',
      'src/b.ts'
    ])
  })

  it('skips URLs and lone words', () => {
    expect(matchFileTokens('https://example.com/a/b plain word')).toEqual([])
  })

  it('skips ~ paths (no home resolution in v1)', () => {
    expect(matchFileTokens('~/notes.md')).toEqual([])
  })
})

describe('resolveFileToken', () => {
  it('passes absolutes through and resolves relatives against cwd', () => {
    expect(resolveFileToken('/etc/hosts', '/repo')).toBe('/etc/hosts')
    expect(resolveFileToken('src/a.ts', '/repo')).toBe('/repo/src/a.ts')
    expect(resolveFileToken('./src/a.ts', '/repo/')).toBe('/repo/src/a.ts')
    expect(resolveFileToken('../other/x.ts', '/repo/sub')).toBe('/repo/other/x.ts')
  })

  it('returns null without a cwd for relatives, and for root-escaping paths', () => {
    expect(resolveFileToken('src/a.ts', undefined)).toBeNull()
    expect(resolveFileToken('../../../../etc/passwd', '/a')).toBeNull()
  })
})
