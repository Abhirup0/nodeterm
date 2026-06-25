import { describe, it, expect } from 'vitest'
import {
  sanitizeWorktreeBranch,
  computeWorktreePath,
  parseWorktreePorcelain,
  isDangerousWorktreeRemovalPath,
  decideMergeStrategy,
  isValidGitRef
} from './worktree'

describe('isValidGitRef', () => {
  it('accepts a normal branch name', () => {
    expect(isValidGitRef('feature/x')).toBe(true)
  })
  it('rejects flag-injection and whitespace', () => {
    expect(isValidGitRef('--force')).toBe(false)
    expect(isValidGitRef('a b')).toBe(false)
    expect(isValidGitRef('')).toBe(false)
  })
})

describe('sanitizeWorktreeBranch', () => {
  it('replaces spaces and illegal chars with dashes', () => {
    expect(sanitizeWorktreeBranch('My Feature!')).toBe('my-feature')
  })
  it('strips leading dashes (flag-injection guard)', () => {
    expect(sanitizeWorktreeBranch('--force')).toBe('force')
  })
})

describe('computeWorktreePath', () => {
  it('builds <userData>/worktrees/<repo>/<branch> with a flattened branch', () => {
    expect(computeWorktreePath('/u', 'myrepo', 'feature/x')).toBe('/u/worktrees/myrepo/feature-x')
  })
})

describe('parseWorktreePorcelain', () => {
  it('parses git worktree list --porcelain blocks', () => {
    const out = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
      'worktree /wt/x', 'HEAD def456', 'branch refs/heads/feature/x', '',
      'worktree /bare', 'bare', ''
    ].join('\n')
    const entries = parseWorktreePorcelain(out)
    expect(entries).toEqual([
      { path: '/repo', head: 'abc123', branch: 'main', isBare: false },
      { path: '/wt/x', head: 'def456', branch: 'feature/x', isBare: false },
      { path: '/bare', head: null, branch: null, isBare: true }
    ])
  })
})

describe('isDangerousWorktreeRemovalPath', () => {
  const home = '/Users/me'
  it('refuses the repo root itself', () => {
    expect(isDangerousWorktreeRemovalPath('/repo', '/repo', home)).toBe(true)
  })
  it('refuses a path that contains the repo', () => {
    expect(isDangerousWorktreeRemovalPath('/repo', '/repo/sub', home)).toBe(true)
  })
  it('refuses home and filesystem root', () => {
    expect(isDangerousWorktreeRemovalPath(home, '/repo', home)).toBe(true)
    expect(isDangerousWorktreeRemovalPath('/', '/repo', home)).toBe(true)
  })
  it('allows a normal sibling worktree dir', () => {
    expect(isDangerousWorktreeRemovalPath('/Users/me/worktrees/r/feature-x', '/repo', home)).toBe(false)
  })
})

describe('decideMergeStrategy', () => {
  it('fetch-updates when base is not checked out anywhere', () => {
    expect(decideMergeStrategy({ baseCheckedOutPath: null, baseDirty: false }))
      .toEqual({ kind: 'fetch-update' })
  })
  it('merges in place when base checkout is clean', () => {
    expect(decideMergeStrategy({ baseCheckedOutPath: '/repo', baseDirty: false }))
      .toEqual({ kind: 'merge-in-place', path: '/repo' })
  })
  it('blocks when base checkout is dirty', () => {
    const r = decideMergeStrategy({ baseCheckedOutPath: '/repo', baseDirty: true })
    expect(r.kind).toBe('blocked')
  })
})
