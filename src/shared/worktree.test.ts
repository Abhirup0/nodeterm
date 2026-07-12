import { describe, it, expect } from 'vitest'
import {
  descendantIds,
  isInsideDir,
  sanitizeWorktreeBranch,
  computeWorktreePath,
  parseWorktreePorcelain,
  isDangerousWorktreeRemovalPath,
  decideMergeStrategy,
  isValidGitRef,
  resolveBaseRef,
  worktreeFromCreate,
  worktreeFromEntry,
  DEFAULT_BASE_REF,
  type WorktreeEntry
} from './worktree'

const entry = (path: string, branch: string | null): WorktreeEntry => ({
  path,
  branch,
  head: 'abc',
  isBare: false
})

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
  it('suggests NOTHING when the base dir is unknown (never a filesystem-root path)', () => {
    // An empty base used to produce `/worktrees/<repo>/<branch>` — i.e. the filesystem root,
    // which the Server Edition (running as root) would happily create.
    expect(computeWorktreePath('', 'myrepo', 'x')).toBe('')
    expect(computeWorktreePath('   ', 'myrepo', 'x')).toBe('')
  })
  it('drops a trailing slash on the base dir', () => {
    expect(computeWorktreePath('/u/', 'r', 'b')).toBe('/u/worktrees/r/b')
  })
})

describe('resolveBaseRef', () => {
  it("uses the main checkout's branch — git prints it first", () => {
    expect(resolveBaseRef([entry('/repo', 'trunk'), entry('/wt/x', 'feature/x')])).toBe('trunk')
    expect(resolveBaseRef([entry('/repo', 'master')])).toBe('master')
  })
  it('falls back to main when the default branch is unknown (detached / empty list)', () => {
    expect(resolveBaseRef([])).toBe(DEFAULT_BASE_REF)
    expect(resolveBaseRef([entry('/repo', null)])).toBe(DEFAULT_BASE_REF)
    expect(resolveBaseRef([entry('/repo', '  ')])).toBe(DEFAULT_BASE_REF)
  })
})

describe('worktreeFromCreate', () => {
  it('marks a worktree the app just created as createdByApp (Remove may delete the dir)', () => {
    expect(
      worktreeFromCreate({
        repoPath: '/repo',
        mode: 'new',
        branch: 'feature/x',
        baseRef: 'master',
        path: '/u/worktrees/repo/feature-x'
      })
    ).toEqual({
      repoPath: '/repo',
      branch: 'feature/x',
      baseRef: 'master',
      path: '/u/worktrees/repo/feature-x',
      createdByApp: true
    })
  })
  it('trims the collected fields', () => {
    const wt = worktreeFromCreate({
      repoPath: ' /repo ',
      mode: 'existing',
      branch: ' feature/x ',
      baseRef: ' main ',
      path: ' /wt/x '
    })
    expect(wt).toMatchObject({ repoPath: '/repo', branch: 'feature/x', baseRef: 'main', path: '/wt/x' })
  })
})

describe('worktreeFromEntry', () => {
  it('marks an ADOPTED worktree as NOT createdByApp (Remove must not delete the user\'s dir)', () => {
    const wt = worktreeFromEntry(entry('/wt/x', 'feature/x'), '/repo', 'trunk')
    expect(wt).toEqual({
      repoPath: '/repo',
      branch: 'feature/x',
      baseRef: 'trunk',
      path: '/wt/x',
      createdByApp: false
    })
  })
  it('defaults the base ref to main when the repo default is unknown', () => {
    expect(worktreeFromEntry(entry('/wt/x', 'feature/x'), '/repo', '')?.baseRef).toBe(DEFAULT_BASE_REF)
  })
  it('refuses a detached worktree or a missing repo root', () => {
    expect(worktreeFromEntry(entry('/wt/x', null), '/repo', 'main')).toBeNull()
    expect(worktreeFromEntry(entry('/wt/x', 'b'), '', 'main')).toBeNull()
    expect(worktreeFromEntry(entry('', 'b'), '/repo', 'main')).toBeNull()
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
      { path: '/repo', head: 'abc123', branch: 'main', isBare: false, prunable: false },
      { path: '/wt/x', head: 'def456', branch: 'feature/x', isBare: false, prunable: false },
      { path: '/bare', head: null, branch: null, isBare: true, prunable: false }
    ])
  })

  // git keeps LISTING a worktree whose directory was deleted behind its back, tagging it
  // `prunable`. Dropping that tag is what would let a dead worktree render as a healthy one.
  it('flags a worktree whose directory is gone as prunable', () => {
    const out = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
      'worktree /wt/gone', 'HEAD def456', 'branch refs/heads/feat',
      'prunable gitdir file points to non-existent location', ''
    ].join('\n')
    const entries = parseWorktreePorcelain(out)
    expect(entries[0].prunable).toBe(false)
    expect(entries[1]).toEqual({
      path: '/wt/gone', head: 'def456', branch: 'feat', isBare: false, prunable: true
    })
  })

  it('flags a bare `prunable` line with no reason', () => {
    const entries = parseWorktreePorcelain(['worktree /wt/gone', 'prunable', ''].join('\n'))
    expect(entries[0].prunable).toBe(true)
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

// Removing a worktree has to reach every node that was living in its directory — a terminal inside
// a NESTED group is in that directory just as much as a direct child, and a chat node's cwd dies
// with it too. A one-level filter left them holding a dead cwd, which is the exact trap the
// destructive-edges work exists to remove.
describe('descendantIds', () => {
  const nodes = [
    { id: 'g' },
    { id: 't1', parentId: 'g' },
    { id: 'inner', parentId: 'g' },
    { id: 't2', parentId: 'inner' }, // two levels down
    { id: 'deep', parentId: 't2' },
    { id: 'outside' }
  ]

  it('collects children AND grandchildren, never a node outside the group', () => {
    expect([...descendantIds(nodes, 'g')].sort()).toEqual(['deep', 'inner', 't1', 't2'])
  })

  it('is empty for a group with no children', () => {
    expect(descendantIds(nodes, 'outside').size).toBe(0)
  })

  it('terminates on a corrupt parent cycle instead of hanging', () => {
    const cyclic = [
      { id: 'a', parentId: 'g' },
      { id: 'b', parentId: 'a' },
      { id: 'g', parentId: 'b' } // g is its own descendant
    ]
    expect([...descendantIds(cyclic, 'g')].sort()).toEqual(['a', 'b', 'g'])
  })
})

describe('isInsideDir', () => {
  it('matches the directory itself and anything under it', () => {
    expect(isInsideDir('/wt/feat', '/wt/feat')).toBe(true)
    expect(isInsideDir('/wt/feat/src', '/wt/feat')).toBe(true)
    expect(isInsideDir('/wt/feat/', '/wt/feat')).toBe(true)
  })
  it('does not match a sibling that merely shares a prefix', () => {
    expect(isInsideDir('/wt/feature', '/wt/feat')).toBe(false)
  })
  it('is false for an unset cwd (nothing to displace)', () => {
    expect(isInsideDir(undefined, '/wt/feat')).toBe(false)
    expect(isInsideDir('', '/wt/feat')).toBe(false)
  })
})
