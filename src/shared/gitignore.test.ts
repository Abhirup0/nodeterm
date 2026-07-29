import { describe, expect, it } from 'vitest'
import { gitignoreAdd, gitignoreHasExact, gitignoreRemove } from './gitignore'

describe('gitignoreHasExact', () => {
  it('matches all four line spellings of the same path', () => {
    for (const line of ['dist', '/dist', 'dist/', '/dist/']) {
      expect(gitignoreHasExact(`node_modules\n${line}\n`, 'dist')).toBe(true)
    }
  })
  it('matches a dir-form relPath against its file-form line', () => {
    expect(gitignoreHasExact('/dist\n', 'dist/')).toBe(true)
  })
  it('does not treat a broader pattern as an exact line', () => {
    expect(gitignoreHasExact('*.log\ndist/*\n', 'a.log')).toBe(false)
    expect(gitignoreHasExact('*.log\ndist/*\n', 'dist')).toBe(false)
  })
  it('ignores surrounding whitespace and CRLF', () => {
    expect(gitignoreHasExact('  /out.txt  \r\nfoo\r\n', 'out.txt')).toBe(true)
  })
  it('is false for an empty path or empty content', () => {
    expect(gitignoreHasExact('', 'dist')).toBe(false)
    expect(gitignoreHasExact('/dist\n', '')).toBe(false)
  })
})

describe('gitignoreAdd', () => {
  it('appends an anchored line with a trailing newline', () => {
    expect(gitignoreAdd('node_modules\n', 'dist/app.js')).toBe('node_modules\n/dist/app.js\n')
  })
  it('starts a missing/empty file cleanly', () => {
    expect(gitignoreAdd('', 'dist')).toBe('/dist\n')
    expect(gitignoreAdd('\n\n', 'dist')).toBe('/dist\n')
  })
  it('inserts exactly one newline after a file with no trailing newline', () => {
    expect(gitignoreAdd('node_modules', 'dist')).toBe('node_modules\n/dist\n')
  })
  it('is a no-op when an exact line already exists in any spelling', () => {
    expect(gitignoreAdd('dist/\n', 'dist')).toBe('dist/\n')
  })
})

describe('gitignoreRemove', () => {
  it('removes every exact spelling, keeps everything else', () => {
    expect(gitignoreRemove('# build\n/dist\ndist/\n*.log\n', 'dist')).toBe('# build\n*.log\n')
  })
  it('leaves broader patterns alone', () => {
    expect(gitignoreRemove('*.log\n', 'a.log')).toBe('*.log\n')
  })
  it('returns empty for a file that only held that line', () => {
    expect(gitignoreRemove('/dist\n', 'dist')).toBe('')
  })
})

describe('round trip', () => {
  it('add then remove restores the original (modulo trailing newline)', () => {
    const base = '# deps\nnode_modules\n'
    expect(gitignoreRemove(gitignoreAdd(base, 'out/build'), 'out/build')).toBe(base)
  })
})
