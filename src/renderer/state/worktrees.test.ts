import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useWorktrees } from './worktrees'

const gitMock = {
  repoRoot: vi.fn(),
  worktreeList: vi.fn(),
  status: vi.fn()
}

beforeEach(() => {
  vi.useRealTimers()
  gitMock.repoRoot.mockReset()
  gitMock.worktreeList.mockReset()
  gitMock.status.mockReset()
  // Test double for the preload/bridge API (the vitest env is `node`, so there is no real window).
  ;(globalThis as { window?: unknown }).window = { nodeTerminal: { git: gitMock } }
  useWorktrees.getState().reset()
})

describe('useWorktrees.refresh', () => {
  it('resolves the repo root from the project cwd and lists that repo´s worktrees', async () => {
    gitMock.repoRoot.mockResolvedValue('/repo')
    gitMock.worktreeList.mockResolvedValue([
      { path: '/repo', branch: 'main', head: 'a', isBare: false },
      { path: '/wt/feat', branch: 'feat', head: 'b', isBare: false }
    ])

    await useWorktrees.getState().refresh('/repo/sub', [])

    expect(gitMock.repoRoot).toHaveBeenCalledWith('/repo/sub')
    expect(gitMock.worktreeList).toHaveBeenCalledWith('/repo')
    expect(useWorktrees.getState().repoRoot).toBe('/repo')
    expect(useWorktrees.getState().entries).toHaveLength(2)
  })

  it('keeps the entries in git´s order (the main checkout must stay first)', async () => {
    gitMock.repoRoot.mockResolvedValue('/repo')
    gitMock.worktreeList.mockResolvedValue([
      { path: '/repo', branch: 'main', head: 'a', isBare: false },
      { path: '/wt/a', branch: 'a', head: 'b', isBare: false },
      { path: '/wt/b', branch: 'b', head: 'c', isBare: false }
    ])

    await useWorktrees.getState().refresh('/repo', [])

    expect(useWorktrees.getState().entries.map((e) => e.path)).toEqual(['/repo', '/wt/a', '/wt/b'])
    // The main checkout is never offered as a deletable orphan.
    expect(useWorktrees.getState().orphans.map((o) => o.path)).toEqual(['/wt/a', '/wt/b'])
  })

  it('classifies stale bindings and orphans', async () => {
    gitMock.repoRoot.mockResolvedValue('/repo')
    gitMock.worktreeList.mockResolvedValue([
      { path: '/repo', branch: 'main', head: 'a', isBare: false },
      { path: '/wt/loose', branch: 'loose', head: 'c', isBare: false }
    ])

    await useWorktrees.getState().refresh('/repo', [
      {
        groupId: 'g1',
        worktree: {
          repoPath: '/repo',
          branch: 'gone',
          baseRef: 'main',
          path: '/wt/gone',
          createdByApp: true
        }
      }
    ])

    expect(useWorktrees.getState().staleGroupIds).toEqual(['g1'])
    expect(useWorktrees.getState().orphans.map((o) => o.path)).toEqual(['/wt/loose'])
  })

  // A group bound to ANOTHER repo's worktree (legacy binding, or hand-typed) must not be
  // reconciled against this repo's entry list — that would falsely mark it stale, and its
  // terminals would stop inheriting the worktree path.
  it('does not mark a group bound to a different repo as stale', async () => {
    gitMock.repoRoot.mockResolvedValue('/repo')
    gitMock.worktreeList.mockResolvedValue([
      { path: '/repo', branch: 'main', head: 'a', isBare: false }
    ])

    await useWorktrees.getState().refresh('/repo', [
      {
        groupId: 'other',
        worktree: {
          repoPath: '/other-repo',
          branch: 'feat',
          baseRef: 'main',
          path: '/other-wt/feat',
          createdByApp: true
        }
      },
      {
        groupId: 'mine',
        worktree: {
          repoPath: '/repo/',
          branch: 'gone',
          baseRef: 'main',
          path: '/wt/gone',
          createdByApp: true
        }
      }
    ])

    expect(useWorktrees.getState().staleGroupIds).toEqual(['mine'])
  })

  it('degrades to empty when the folder is not a git repo (repoRoot null)', async () => {
    gitMock.repoRoot.mockResolvedValue(null)

    await useWorktrees.getState().refresh('/not/a/repo', [])

    expect(useWorktrees.getState().repoRoot).toBeNull()
    expect(useWorktrees.getState().entries).toEqual([])
    expect(gitMock.worktreeList).not.toHaveBeenCalled()
  })
})

describe('useWorktrees.refreshStatus', () => {
  it('maps a git status into the chip´s numbers', async () => {
    gitMock.status.mockResolvedValue({
      branch: 'feat',
      staged: [{ path: 'a' }],
      changes: [{ path: 'b' }, { path: 'c' }],
      ahead: 3,
      behind: 1
    })

    await useWorktrees.getState().refreshStatus('/wt/feat')

    expect(useWorktrees.getState().statusByPath['/wt/feat']).toEqual({
      branch: 'feat',
      dirty: 3,
      ahead: 3,
      behind: 1
    })
  })

  // The chip re-renders on every canvas interaction; without a throttle each one would
  // spawn a `git status` subprocess.
  it('throttles repeated calls for the same path', async () => {
    gitMock.status.mockResolvedValue({ branch: 'feat', staged: [], changes: [], ahead: 0, behind: 0 })

    await useWorktrees.getState().refreshStatus('/wt/feat')
    await useWorktrees.getState().refreshStatus('/wt/feat')

    expect(gitMock.status).toHaveBeenCalledTimes(1)
  })
})
