import { describe, it, expect } from 'vitest'
import { prepareQuickOpenFiles, rankQuickOpenFiles } from './quickOpenSearch'

const files = prepareQuickOpenFiles([
  'src/main/index.ts',
  'src/renderer/components/CommandPalette.tsx',
  'dist/nodeterm-0.2.0-arm64.dmg',
  'README.md'
])

describe('rankQuickOpenFiles', () => {
  it('empty query returns first N in input order', () => {
    const r = rankQuickOpenFiles('', files, 2)
    expect(r.map((x) => x.path)).toEqual(['src/main/index.ts', 'src/renderer/components/CommandPalette.tsx'])
  })
  it('finds a git-ignored artifact by name fragment', () => {
    const r = rankQuickOpenFiles('dmg', files)
    expect(r[0].path).toBe('dist/nodeterm-0.2.0-arm64.dmg')
  })
  it('a filename hit outranks a path-only subsequence hit', () => {
    const r = rankQuickOpenFiles('index', files)
    expect(r[0].path).toBe('src/main/index.ts')
  })
  it('returns nothing when the subsequence is absent', () => {
    expect(rankQuickOpenFiles('zzzz', files)).toEqual([])
  })
  it('respects the limit', () => {
    expect(rankQuickOpenFiles('s', files, 1).length).toBe(1)
  })
})
