import { describe, it, expect } from 'vitest'
import { reconcileWorktrees, type BoundGroup } from './worktree-reconcile'
import type { WorktreeEntry } from './worktree'

const wt = (path: string, branch: string | null): WorktreeEntry => ({
  path,
  branch,
  head: 'abc123',
  isBare: false
})

const bound = (groupId: string, path: string, branch: string): BoundGroup => ({
  groupId,
  worktree: { repoPath: '/repo', branch, baseRef: 'main', path, createdByApp: true }
})

describe('reconcileWorktrees', () => {
  it('reports a binding whose worktree still exists as live', () => {
    const r = reconcileWorktrees([bound('g1', '/wt/feat', 'feat')], [wt('/repo', 'main'), wt('/wt/feat', 'feat')])
    expect(r.live).toEqual(['g1'])
    expect(r.stale).toEqual([])
  })

  it('reports a binding whose worktree is gone from disk as stale', () => {
    const r = reconcileWorktrees([bound('g1', '/wt/feat', 'feat')], [wt('/repo', 'main')])
    expect(r.stale).toEqual(['g1'])
    expect(r.live).toEqual([])
  })

  it('ignores a trailing slash when matching paths', () => {
    const r = reconcileWorktrees([bound('g1', '/wt/feat/', 'feat')], [wt('/repo', 'main'), wt('/wt/feat', 'feat')])
    expect(r.live).toEqual(['g1'])
  })

  it('reports a worktree on disk that no group is bound to as an orphan', () => {
    const r = reconcileWorktrees([], [wt('/repo', 'main'), wt('/wt/loose', 'loose')])
    expect(r.orphans.map((o) => o.path)).toEqual(['/wt/loose'])
  })

  // The main checkout is itself an entry in `git worktree list`. Offering it as a
  // recoverable "orphan" would invite the user to delete their own repo.
  it('never reports the main checkout as an orphan', () => {
    const r = reconcileWorktrees([], [wt('/repo', 'main')])
    expect(r.orphans).toEqual([])
  })

  it('skips bare entries', () => {
    const entries: WorktreeEntry[] = [{ path: '/repo.git', branch: null, head: null, isBare: true }]
    const r = reconcileWorktrees([], entries)
    expect(r.orphans).toEqual([])
  })

  it('classifies a mixed workspace in one pass', () => {
    const r = reconcileWorktrees(
      [bound('g1', '/wt/a', 'a'), bound('g2', '/wt/gone', 'gone')],
      [wt('/repo', 'main'), wt('/wt/a', 'a'), wt('/wt/loose', 'loose')]
    )
    expect(r.live).toEqual(['g1'])
    expect(r.stale).toEqual(['g2'])
    expect(r.orphans.map((o) => o.path)).toEqual(['/wt/loose'])
  })
})
