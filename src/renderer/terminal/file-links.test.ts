import { describe, expect, it } from 'vitest'
import {
  makeDirListingLookup,
  matchFileTokens,
  matchUrlTokens,
  paragraphContaining,
  resolveFileToken,
  type BufferView
} from './file-links'

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

  it('preserves a tilde-rooted cwd (SSH default) instead of mangling it to /~', () => {
    expect(resolveFileToken('src/a.ts', '~/proj')).toBe('~/proj/src/a.ts')
    expect(resolveFileToken('./src/a.ts', '~')).toBe('~/src/a.ts')
    expect(resolveFileToken('../x.ts', '~/proj/sub')).toBe('~/proj/x.ts')
    expect(resolveFileToken('../../../x.ts', '~/proj')).toBeNull() // .. may not pop the ~
    expect(resolveFileToken('/abs/x.ts', '~/proj')).toBe('/abs/x.ts') // absolutes unaffected
  })
})

describe('POSIX existence lookup', () => {
  it('keeps a backslash inside the filename and matches case-sensitively', async () => {
    const listed: string[] = []
    const lookup = makeDirListingLookup(async (dir) => {
      listed.push(dir)
      return [
        { name: String.raw`name\part.ts`, dir: false },
        { name: 'CASE.ts', dir: false }
      ]
    })

    await expect(lookup(String.raw`/repo/name\part.ts`)).resolves.toEqual({
      exists: true,
      dir: false
    })
    await expect(lookup('/repo/case.ts')).resolves.toEqual({ exists: false, dir: false })
    expect(listed).toEqual(['/repo'])
  })
})

/** Fake buffer: each entry is a row's content; `w:` prefix marks it soft-wrapped. Rows are
 *  stored untrimmed exactly as given (pad to `cols` yourself to simulate a full row). */
function view(cols: number, rows: string[]): BufferView {
  const parsed = rows.map((r) =>
    r.startsWith('w:') ? { wrapped: true, text: r.slice(2) } : { wrapped: false, text: r }
  )
  return {
    cols,
    length: parsed.length,
    line: (row) => {
      const p = parsed[row]
      return p
        ? { isWrapped: p.wrapped, text: (trim) => (trim ? p.text.replace(/\s+$/, '') : p.text) }
        : undefined
    }
  }
}

describe('paragraphContaining', () => {
  it('joins soft-wrapped rows from any row of the paragraph', () => {
    const v = view(10, ['prompt>   ', 'https://x.', 'w:io/abc'])
    for (const row of [1, 2]) {
      const p = paragraphContaining(v, row)!
      expect(p.startRow).toBe(1)
      expect(p.text).toBe('https://x.io/abc')
      expect(p.rows).toBe(2)
    }
    // row 0 does not run into row 1 (it has trailing spaces) — separate paragraph
    expect(paragraphContaining(v, 0)!.text).toBe('prompt>')
  })

  it('joins HARD-wrapped rows (tmux repaint / TUI): full last column + non-space next start', () => {
    // 10-col screen painting "https://claude.com/oauth?x=1" as three hard rows
    const v = view(10, ['https://cl', 'aude.com/o', 'auth?x=1'])
    for (const row of [0, 1, 2]) {
      const p = paragraphContaining(v, row)!
      expect(p.startRow).toBe(0)
      expect(p.text).toBe('https://claude.com/oauth?x=1')
    }
    expect(matchUrlTokens(paragraphContaining(v, 1)!.text)[0].url).toBe(
      'https://claude.com/oauth?x=1'
    )
  })

  it('does NOT join when the row is not full to the last column', () => {
    const v = view(10, ['https://x ', 'unrelated'])
    expect(paragraphContaining(v, 0)!.text).toBe('https://x')
  })

  it('does NOT join when the next row starts with a space', () => {
    const v = view(10, ['aaaaaaaaaa', ' indented'])
    expect(paragraphContaining(v, 0)!.text).toBe('aaaaaaaaaa')
  })

  it('index math holds across hard rows (every joined row contributes exactly cols chars)', () => {
    const v = view(10, ['see https:', '//x.io/abc', 'd now'])
    const p = paragraphContaining(v, 0)!
    const [u] = matchUrlTokens(p.text)
    expect(u.url).toBe('https://x.io/abcd')
    // token starts at index 4 → row 0 col 4; ends at index 20 → row 2 col 0
    expect(Math.floor(u.startIndex / 10)).toBe(0)
    expect(Math.floor((u.startIndex + u.text.length - 1) / 10)).toBe(2)
  })

  it('caps runaway joins at MAX_JOIN_ROWS', () => {
    const wall = Array.from({ length: 80 }, () => 'x'.repeat(10))
    const p = paragraphContaining(view(10, wall), 0)!
    expect(p.rows).toBeLessThanOrEqual(32)
  })
})

describe('matchUrlTokens', () => {
  it('finds http(s) URLs with their start index', () => {
    const t = matchUrlTokens('open https://example.com/a/b and http://x.io/p here')
    expect(t.map((x) => x.url)).toEqual(['https://example.com/a/b', 'http://x.io/p'])
    expect(t[0].startIndex).toBe(5)
  })

  it('strips trailing sentence punctuation', () => {
    expect(matchUrlTokens('see https://example.com/a.').map((x) => x.url)).toEqual([
      'https://example.com/a'
    ])
    expect(matchUrlTokens('(https://example.com/a)').map((x) => x.url)).toEqual([
      'https://example.com/a'
    ])
  })

  it('ignores non-http schemes and bare paths', () => {
    expect(matchUrlTokens('ftp://x.io file:///etc/hosts /usr/local plain')).toEqual([])
  })
})
