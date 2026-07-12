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
      behind: 1,
      hasRemote: false
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

  // `refresh()` only runs on project load / mutation, so without this the chip of a worktree
  // deleted WHILE THE USER WATCHES would keep claiming to be healthy until a reload.
  it('marks the group stale when its worktree stops being a repo (after a second read agrees)', async () => {
    const t0 = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(t0)
    gitMock.status.mockResolvedValue(okStatus({ hasRepo: false, branch: '' }))

    await useWorktrees.getState().refreshStatus('/wt/gone', 'group-1')
    vi.setSystemTime(t0 + WORKTREE_STATUS_THROTTLE_MS + 1)
    await useWorktrees.getState().refreshStatus('/wt/gone', 'group-1')

    expect(useWorktrees.getState().staleGroupIds).toEqual(['group-1'])
  })

  // `git rev-parse --is-inside-work-tree` merely FAILING (spawn EAGAIN under load, an NFS/FUSE
  // hiccup) also answers hasRepo:false. Flipping a healthy worktree to "missing" on one such read
  // is not cosmetic: while it lasts, cwdForNewNodeIn hands out the project cwd instead of the
  // worktree path, and a terminal created in that window persists the WRONG cwd forever.
  it('does not flip a healthy worktree to stale on a single hasRepo:false read', async () => {
    const t0 = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(t0)
    gitMock.status.mockResolvedValue(okStatus({ hasRepo: false, branch: '' }))

    await useWorktrees.getState().refreshStatus('/wt/feat', 'group-1')

    expect(useWorktrees.getState().staleGroupIds).toEqual([])
  })

  it('forgets the miss when the next read succeeds (a transient failure never accumulates)', async () => {
    const t0 = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(t0)
    gitMock.status.mockResolvedValue(okStatus({ hasRepo: false, branch: '' }))
    await useWorktrees.getState().refreshStatus('/wt/feat', 'group-1')

    vi.setSystemTime(t0 + WORKTREE_STATUS_THROTTLE_MS + 1)
    gitMock.status.mockResolvedValue(okStatus())
    await useWorktrees.getState().refreshStatus('/wt/feat', 'group-1')
    expect(useWorktrees.getState().staleGroupIds).toEqual([])

    // A LATER isolated miss must start counting from scratch, not tip the group over.
    vi.setSystemTime(t0 + 2 * WORKTREE_STATUS_THROTTLE_MS + 2)
    gitMock.status.mockResolvedValue(okStatus({ hasRepo: false, branch: '' }))
    await useWorktrees.getState().refreshStatus('/wt/feat', 'group-1')
    expect(useWorktrees.getState().staleGroupIds).toEqual([])
  })

  it('un-marks a stale group once its worktree answers again', async () => {
    const t0 = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(t0)
    gitMock.status.mockResolvedValue(okStatus({ hasRepo: false, branch: '' }))
    await useWorktrees.getState().refreshStatus('/wt/feat', 'group-1')
    vi.setSystemTime(t0 + WORKTREE_STATUS_THROTTLE_MS + 1)
    await useWorktrees.getState().refreshStatus('/wt/feat', 'group-1')
    expect(useWorktrees.getState().staleGroupIds).toEqual(['group-1'])

    // Restored — past the throttle window.
    vi.setSystemTime(t0 + 2 * WORKTREE_STATUS_THROTTLE_MS + 2)
    gitMock.status.mockResolvedValue(okStatus())
    await useWorktrees.getState().refreshStatus('/wt/feat', 'group-1')

    expect(useWorktrees.getState().staleGroupIds).toEqual([])
    expect(useWorktrees.getState().statusByPath['/wt/feat'].branch).toBe('feat')
  })

  // The merge confirm has to tell the user whether merging also PUBLISHES to origin, and it reads
  // that fact from here (the store is the only caller of the status IPC).
  it('carries hasRemote into the chip status (the merge confirm reads it)', async () => {
    gitMock.status.mockResolvedValue(okStatus({ hasRemote: true }))

    await useWorktrees.getState().refreshStatus('/wt/feat')

    expect(useWorktrees.getState().statusByPath['/wt/feat'].hasRemote).toBe(true)
  })

  it('leaves staleness alone when no group id is given', async () => {
    gitMock.status.mockResolvedValue(okStatus({ hasRepo: false, branch: '' }))

    await useWorktrees.getState().refreshStatus('/wt/gone')

    expect(useWorktrees.getState().staleGroupIds).toEqual([])
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
      behind: 0,
      hasRemote: false
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

describe('useWorktrees.refresh interleaving without reset', () => {
  // Two rapid refresh calls without an intervening reset would previously race: both capture the
  // same epoch, so the older project's in-flight reads would overwrite the newer project's facts.
  // This test ensures the epoch is bumped at the START of each refresh, so a newer refresh always
  // supersedes an older one.
  afterEach(() => vi.useRealTimers())

  it('a newer refresh always supersedes an in-flight older one', async () => {
    let releaseRootA: (v: string) => void = () => {}
    let releaseListA: (v: unknown[]) => void = () => {}

    const promiseRootA = new Promise<string>((r) => (releaseRootA = r))
    const promiseListA = new Promise<unknown[]>((r) => (releaseListA = r))

    // Track which cwd/root is being queried and return appropriate promises.
    gitMock.repoRoot.mockImplementation((cwd: string) => {
      if (cwd === '/repo-a') return promiseRootA
      return Promise.resolve('/repo-b')
    })

    gitMock.worktreeList.mockImplementation((root: string) => {
      if (root === '/repo-a') return promiseListA
      return Promise.resolve([
        { path: '/repo-b', branch: 'main', head: 'b1', isBare: false },
        { path: '/wt/b-feat', branch: 'b-feat', head: 'b2', isBare: false }
      ])
    })

    // Start refresh for repo A (in flight, blocked on our controlled promises).
    const refreshA = useWorktrees.getState().refresh('/repo-a', [])

    // Start refresh for repo B while A is still in flight. B should bump the epoch past A's,
    // so even though A resolves later, its older epoch is stale and its write is dropped.
    const refreshB = useWorktrees.getState().refresh('/repo-b', [])
    await refreshB

    // Now let A finish. Even though A resolves after B, the epoch bump ensures A's older
    // epoch is stale and its write is dropped.
    releaseRootA('/repo-a')
    releaseListA([
      { path: '/repo-a', branch: 'main', head: 'a1', isBare: false },
      { path: '/wt/a-old', branch: 'a-old', head: 'a2', isBare: false }
    ])
    await refreshA

    // The store must hold B's facts, not A's. If the epoch is not bumped per-refresh, A's later
    // write would have overwritten B.
    expect(useWorktrees.getState().repoRoot).toBe('/repo-b')
    expect(useWorktrees.getState().entries.map((e) => e.path)).toEqual([
      '/repo-b',
      '/wt/b-feat'
    ])
  })
})
