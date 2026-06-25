import { describe, it, expect } from 'vitest'
import {
  shouldIncludeQuickOpenPath,
  buildHiddenDirExcludeGlobs,
  buildRgArgsForQuickOpen,
  buildGitLsFilesArgs,
  normalizeQuickOpenRgLine
} from './quick-open-filter'

describe('shouldIncludeQuickOpenPath', () => {
  it('keeps normal source and git-ignored build output', () => {
    expect(shouldIncludeQuickOpenPath('src/main/index.ts')).toBe(true)
    expect(shouldIncludeQuickOpenPath('dist/nodeterm-0.2.0-arm64.dmg')).toBe(true)
    expect(shouldIncludeQuickOpenPath('.claude/worktrees/b5-test/dist/app.dmg')).toBe(true)
  })
  it('drops node_modules, .git and blocklisted dirs at any depth', () => {
    expect(shouldIncludeQuickOpenPath('node_modules/react/index.js')).toBe(false)
    expect(shouldIncludeQuickOpenPath('a/b/node_modules/x.js')).toBe(false)
    expect(shouldIncludeQuickOpenPath('.git/config')).toBe(false)
    expect(shouldIncludeQuickOpenPath('.cache/x')).toBe(false)
    expect(shouldIncludeQuickOpenPath('packages/.vscode/settings.json')).toBe(false)
  })
})

describe('normalizeQuickOpenRgLine', () => {
  it('strips ./ prefix and trailing CR, returns null for junk', () => {
    expect(normalizeQuickOpenRgLine('./src/a.ts')).toBe('src/a.ts')
    expect(normalizeQuickOpenRgLine('src/a.ts\r')).toBe('src/a.ts')
    expect(normalizeQuickOpenRgLine('')).toBeNull()
    expect(normalizeQuickOpenRgLine('.')).toBeNull()
    expect(normalizeQuickOpenRgLine('../escape')).toBeNull()
  })
  it('forces forward slashes', () => {
    expect(normalizeQuickOpenRgLine('src\\main\\a.ts')).toBe('src/main/a.ts')
  })
})

describe('arg builders', () => {
  it('rg primary respects ignore, ignoredPass adds --no-ignore-vcs; both prune node_modules', () => {
    const { primary, ignoredPass } = buildRgArgsForQuickOpen({ forceSlashSeparator: false })
    expect(primary).toContain('--files')
    expect(primary).toContain('--hidden')
    expect(primary).not.toContain('--no-ignore-vcs')
    expect(ignoredPass).toContain('--no-ignore-vcs')
    expect(buildHiddenDirExcludeGlobs()).toContain('!**/node_modules')
    expect(primary).toContain('!**/node_modules')
  })
  it('git ls-files primary lists tracked+untracked, ignoredPass adds --ignored', () => {
    const { primary, ignoredPass } = buildGitLsFilesArgs()
    expect(primary).toEqual(['-z', '--cached', '--others', '--exclude-standard'])
    expect(ignoredPass).toEqual(['-z', '--others', '--ignored', '--exclude-standard'])
  })
})
