import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useWorktrees, WORKTREE_STATUS_THROTTLE_MS } from './worktrees'

/** A `git status` on a healthy worktree, with only the fields the store reads spelled out. */
const okStatus = (over: Partial<Record<string, unknown>> = {}): unknown => ({
  hasRepo: true,
  branch: 'feat',
  staged: [],
  changes: [],
  ahead: 0,
  behind: 0,
  ...over
})

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
    gitMock.status.mockResolvedValue(
      okStatus({ staged: [{ path: 'a' }], changes: [{ path: 'b' }, { path: 'c' }], ahead: 3, behind: 1 })
    )

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
    gitMock.status.mockResolvedValue(okStatus())

    await useWorktrees.getState().refreshStatus('/wt/feat')
    await useWorktrees.getState().refreshStatus('/wt/feat')

    expect(gitMock.status).toHaveBeenCalledTimes(1)
  })

  // Pins the throttle WINDOW, not just its existence: a throttle that never expired would pass
  // the test above but leave the chip frozen on its first reading forever.
  it('lets a call through again once the throttle window has expired', async () => {
    const t0 = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(t0)
    gitMock.status.mockResolvedValue(okStatus())

    await useWorktrees.getState().refreshStatus('/wt/feat')
    vi.setSystemTime(t0 + WORKTREE_STATUS_THROTTLE_MS - 1)
    await useWorktrees.getState().refreshStatus('/wt/feat')
    expect(gitMock.status).toHaveBeenCalledTimes(1)

    vi.setSystemTime(t0 + WORKTREE_STATUS_THROTTLE_MS + 1)
    await useWorktrees.getState().refreshStatus('/wt/feat')
    expect(gitMock.status).toHaveBeenCalledTimes(2)
  })

  // `git.status()` does NOT throw on a path that is no longer a repo (the worktree was deleted
  // outside the app): core/git-service returns an empty status with hasRepo:false. Writing that
  // would render a dead worktree as a healthy one with a blank branch — `staleGroupIds` is what
  // tells that story.
  it('ignores a status for a path that is not a repo (hasRepo false)', async () => {
    gitMock.status.mockResolvedValue(okStatus({ hasRepo: false, branch: '' }))

    await useWorktrees.getState().refreshStatus('/wt/gone')

    expect(useWorktrees.getState().statusByPath['/wt/gone']).toBeUndefined()
  })

  // Callers fire this from React effects; over the Server Edition's WS-RPC bridge a transport
  // error REJECTS, which would become an unhandled rejection.
  it('swallows an IPC rejection and leaves the previous status intact', async () => {
    gitMock.status.mockResolvedValue(okStatus({ ahead: 2 }))
    await useWorktrees.getState().refreshStatus('/wt/feat')

    lastStatusWindowExpired()
    gitMock.status.mockRejectedValue(new Error('bridge closed'))
    await expect(useWorktrees.getState().refreshStatus('/wt/feat')).resolves.toBeUndefined()

    expect(useWorktrees.getState().statusByPath['/wt/feat']).toEqual({
      branch: 'feat',
      dirty: 0,
      ahead: 2,
      behind: 0
    })
  })

  // The throttle stamp is taken before the await; if a failure kept it, the chip would be locked
  // out of retrying for the whole window over a transient error.
  it('does not burn the throttle window on a failed call', async () => {
    gitMock.status.mockRejectedValueOnce(new Error('nope')).mockResolvedValue(okStatus())

    await useWorktrees.getState().refreshStatus('/wt/feat')
    await useWorktrees.getState().refreshStatus('/wt/feat')

    expect(gitMock.status).toHaveBeenCalledTimes(2)
    expect(useWorktrees.getState().statusByPath['/wt/feat']?.branch).toBe('feat')
  })

  it('reset() clears the collected statuses', async () => {
    gitMock.status.mockResolvedValue(okStatus())
    await useWorktrees.getState().refreshStatus('/wt/feat')
    expect(useWorktrees.getState().statusByPath['/wt/feat']).toBeDefined()

    useWorktrees.getState().reset()

    expect(useWorktrees.getState().statusByPath).toEqual({})
  })
})

/** Push the clock past the throttle window without touching the (real-timer) default. */
function lastStatusWindowExpired(): void {
  const now = Date.now()
  vi.useFakeTimers()
  vi.setSystemTime(now + WORKTREE_STATUS_THROTTLE_MS + 1)
}

// `refresh`/`refreshStatus` are async with no cancellation, and are fired from React effects on
// project switch. A stale in-flight call resolving AFTER the switch would overwrite the new
// project's facts with the old project's — and Task 3 creates worktrees under `repoRoot` while
// Task 4 offers `orphans` for deletion, so a stale write is live ammunition.
describe('useWorktrees cancellation on reset', () => {
  afterEach(() => vi.useRealTimers())

  it('drops a refresh that resolves after a reset', async () => {
    let releaseRoot: (v: string) => void = () => {}
    gitMock.repoRoot.mockReturnValue(new Promise<string>((r) => (releaseRoot = r)))
    gitMock.worktreeList.mockResolvedValue([
      { path: '/repo', branch: 'main', head: 'a', isBare: false },
      { path: '/wt/old', branch: 'old', head: 'b', isBare: false }
    ])

    const inFlight = useWorktrees.getState().refresh('/repo', [])
    useWorktrees.getState().reset()
    releaseRoot('/repo')
    await inFlight

    expect(useWorktrees.getState().repoRoot).toBeNull()
    expect(useWorktrees.getState().entries).toEqual([])
    expect(useWorktrees.getState().orphans).toEqual([])
  })

  it('drops the not-a-repo branch of a refresh that resolves after a reset', async () => {
    gitMock.repoRoot.mockResolvedValue('/repo')
    gitMock.worktreeList.mockResolvedValue([
      { path: '/repo', branch: 'main', head: 'a', isBare: false }
    ])
    await useWorktrees.getState().refresh('/repo', [])

    let releaseRoot: (v: string | null) => void = () => {}
    gitMock.repoRoot.mockReturnValue(new Promise<string | null>((r) => (releaseRoot = r)))
    const inFlight = useWorktrees.getState().refresh('/other', [])
    useWorktrees.getState().reset()
    releaseRoot(null)
    await inFlight

    // reset() already emptied the store; the stale call must not write to it at all.
    expect(useWorktrees.getState().repoRoot).toBeNull()
  })

  it('drops a status that resolves after a reset', async () => {
    let releaseStatus: (v: unknown) => void = () => {}
    gitMock.status.mockReturnValue(new Promise((r) => (releaseStatus = r)))

    const inFlight = useWorktrees.getState().refreshStatus('/wt/feat')
    useWorktrees.getState().reset()
    releaseStatus(okStatus())
    await inFlight

    expect(useWorktrees.getState().statusByPath).toEqual({})
  })
})

describe('useWorktrees.refresh error handling', () => {
  it('swallows an IPC rejection and empties the store (fail open)', async () => {
    gitMock.repoRoot.mockResolvedValue('/repo')
    gitMock.worktreeList.mockResolvedValue([
      { path: '/repo', branch: 'main', head: 'a', isBare: false },
      { path: '/wt/a', branch: 'a', head: 'b', isBare: false }
    ])
    await useWorktrees.getState().refresh('/repo', [])
    expect(useWorktrees.getState().entries).toHaveLength(2)

    gitMock.worktreeList.mockRejectedValue(new Error('bridge closed'))
    await expect(useWorktrees.getState().refresh('/repo', [])).resolves.toBeUndefined()

    expect(useWorktrees.getState().repoRoot).toBeNull()
    expect(useWorktrees.getState().entries).toEqual([])
    expect(useWorktrees.getState().orphans).toEqual([])
    expect(useWorktrees.getState().staleGroupIds).toEqual([])
  })
})
