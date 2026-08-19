import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ProjectLaunchInfo } from '@shared/project-settings'
import {
  ensureProjectLaunchInfo,
  invalidateProjectLaunchInfo,
  projectLaunchInfoNow,
  resetProjectLaunchInfoForTests
} from './projectLaunchInfo'

const INFO: ProjectLaunchInfo = {
  resolved: { setup: {}, worktree: {}, agents: {}, terminal: {} },
  trusted: { agents: true, shell: true }
}

/** Stand in for the preload/bridge `projectSettings.launchInfo()` call. */
function mockLaunchInfo(
  answer: ProjectLaunchInfo | null | Error | (() => Promise<ProjectLaunchInfo | null>)
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => {
    if (typeof answer === 'function') return answer()
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  })
  ;(globalThis as { window?: unknown }).window = {
    nodeTerminal: { projectSettings: { launchInfo: fn } }
  }
  return fn
}

beforeEach(() => {
  resetProjectLaunchInfoForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('projectLaunchInfoNow', () => {
  it('is null before anything has ever been fetched', () => {
    expect(projectLaunchInfoNow('p1')).toBeNull()
  })

  it('holds the fetched value once ensure resolves', async () => {
    mockLaunchInfo(INFO)
    await ensureProjectLaunchInfo('p1')
    expect(projectLaunchInfoNow('p1')).toEqual(INFO)
  })

  it('is scoped per project — fetching one project never populates another', async () => {
    mockLaunchInfo(INFO)
    await ensureProjectLaunchInfo('p1')
    expect(projectLaunchInfoNow('p1')).toEqual(INFO)
    expect(projectLaunchInfoNow('p2')).toBeNull()
  })
})

describe('ensureProjectLaunchInfo', () => {
  it('memoizes an in-flight fetch — two concurrent callers trigger one wire call', async () => {
    let resolve!: (v: ProjectLaunchInfo | null) => void
    const fn = mockLaunchInfo(() => new Promise((r) => (resolve = r)))
    const a = ensureProjectLaunchInfo('p1')
    const b = ensureProjectLaunchInfo('p1')
    await Promise.resolve() // let the mock's executor run so `resolve` is bound
    resolve(INFO)
    await Promise.all([a, b])
    expect(fn).toHaveBeenCalledTimes(1)
    expect(projectLaunchInfoNow('p1')).toEqual(INFO)
  })

  it('never rejects when the wire call rejects — the cache is left as-is (fail open)', async () => {
    mockLaunchInfo(new Error('rpc down'))
    await expect(ensureProjectLaunchInfo('p1')).resolves.toBeUndefined()
    expect(projectLaunchInfoNow('p1')).toBeNull()
  })

  it('is bounded — a wire call that never answers still resolves ensure within the wait window', async () => {
    vi.useFakeTimers()
    mockLaunchInfo(() => new Promise<ProjectLaunchInfo | null>(() => {}))
    const pending = ensureProjectLaunchInfo('p1')
    await vi.advanceTimersByTimeAsync(3000)
    await expect(pending).resolves.toBeUndefined()
    // The bounded timeout gave up on the round trip — nothing to show yet.
    expect(projectLaunchInfoNow('p1')).toBeNull()
  })

  it('a late answer after the bound still lands in the cache for the NEXT read', async () => {
    vi.useFakeTimers()
    let resolve!: (v: ProjectLaunchInfo | null) => void
    mockLaunchInfo(() => new Promise((r) => (resolve = r)))
    const pending = ensureProjectLaunchInfo('p1')
    await vi.advanceTimersByTimeAsync(3000)
    await pending // gave up waiting
    expect(projectLaunchInfoNow('p1')).toBeNull()
    resolve(INFO)
    await vi.advanceTimersByTimeAsync(0)
    expect(projectLaunchInfoNow('p1')).toEqual(INFO)
  })

  // The wire call this project's first fetch is waiting on may NEVER answer at all — a dropped
  // Server Edition WS-RPC request neither times out nor rejects (permissionMode.ts's
  // `CAPS_WAIT_MS` doc). Without clearing the in-flight entry on timeout, every later `ensure`
  // for this project would just rejoin that exhausted promise and no fresh wire call would ever
  // be issued again.
  it('a timed-out fetch is retried on the NEXT ensure, and its late answer cannot clobber the retry', async () => {
    vi.useFakeTimers()
    let resolveStale!: (v: ProjectLaunchInfo | null) => void
    const staleInfo: ProjectLaunchInfo = { ...INFO, trusted: { agents: false, shell: true } }
    const freshInfo: ProjectLaunchInfo = { ...INFO, trusted: { agents: true, shell: true } }
    // Gated — never answers on its own until `resolveStale` is called.
    const fn = mockLaunchInfo(() => new Promise((r) => (resolveStale = r)))

    const first = ensureProjectLaunchInfo('p1')
    await vi.advanceTimersByTimeAsync(3000)
    await first // gave up waiting

    fn.mockImplementation(() => Promise.resolve(freshInfo))
    await ensureProjectLaunchInfo('p1') // must issue a SECOND wire call, not rejoin the first
    expect(fn).toHaveBeenCalledTimes(2)
    expect(projectLaunchInfoNow('p1')).toEqual(freshInfo)

    // The abandoned first fetch finally answers — its write must be discarded, never overwrite
    // the retry's fresher result (the generation guard).
    resolveStale(staleInfo)
    await vi.advanceTimersByTimeAsync(0)
    expect(projectLaunchInfoNow('p1')).toEqual(freshInfo)
  })
})

describe('invalidateProjectLaunchInfo', () => {
  it('clears the cached value back to null', async () => {
    mockLaunchInfo(INFO)
    await ensureProjectLaunchInfo('p1')
    expect(projectLaunchInfoNow('p1')).toEqual(INFO)
    invalidateProjectLaunchInfo('p1')
    expect(projectLaunchInfoNow('p1')).toBeNull()
  })

  it('only clears the invalidated project', async () => {
    mockLaunchInfo(INFO)
    await ensureProjectLaunchInfo('p1')
    await ensureProjectLaunchInfo('p2')
    invalidateProjectLaunchInfo('p1')
    expect(projectLaunchInfoNow('p1')).toBeNull()
    expect(projectLaunchInfoNow('p2')).toEqual(INFO)
  })

  it('rewarm after a trust change: invalidate then ensure fetches a fresh answer', async () => {
    const untrusted: ProjectLaunchInfo = { ...INFO, trusted: { agents: false, shell: true } }
    const fn = mockLaunchInfo(untrusted)
    await ensureProjectLaunchInfo('p1')
    expect(projectLaunchInfoNow('p1')?.trusted.agents).toBe(false)

    // The trust dialog was answered — a later fetch now reports true. Simulates the
    // `onTrustChanged` handler's invalidate+ensure pair.
    fn.mockImplementation(() => Promise.resolve({ ...INFO, trusted: { agents: true, shell: true } }))
    invalidateProjectLaunchInfo('p1')
    expect(projectLaunchInfoNow('p1')).toBeNull()
    await ensureProjectLaunchInfo('p1')
    expect(projectLaunchInfoNow('p1')?.trusted.agents).toBe(true)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('a fetch already in flight when invalidate fires does not clobber a fresher one', async () => {
    let resolveStale!: (v: ProjectLaunchInfo | null) => void
    const staleInfo: ProjectLaunchInfo = { ...INFO, trusted: { agents: false, shell: true } }
    const freshInfo: ProjectLaunchInfo = { ...INFO, trusted: { agents: true, shell: true } }
    const fn = mockLaunchInfo(() => new Promise((r) => (resolveStale = r)))

    const stale = ensureProjectLaunchInfo('p1') // in flight, unresolved
    await Promise.resolve() // let the mock's executor run so `resolveStale` is bound
    invalidateProjectLaunchInfo('p1') // abandons it — bumps the generation
    fn.mockImplementation(() => Promise.resolve(freshInfo))
    await ensureProjectLaunchInfo('p1') // a fresh fetch, resolves immediately
    expect(projectLaunchInfoNow('p1')).toEqual(freshInfo)

    // The abandoned fetch finally answers — its write must be discarded, not overwrite `freshInfo`.
    resolveStale(staleInfo)
    await stale
    expect(projectLaunchInfoNow('p1')).toEqual(freshInfo)
  })
})
