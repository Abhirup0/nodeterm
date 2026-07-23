import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerWebglClient,
  __resetWebglBudgetForTests,
  getWebglBudget,
  loseWebglContexts,
  setWebglBudget,
  WEBGL_ACQUIRE_DEBOUNCE_MS,
  WEBGL_BUDGET,
  WEBGL_LOSS_STREAK_MAX,
  WEBGL_REACQUIRE_AFTER_LOSS_MS,
  WEBGL_RELEASE_DELAY_MS,
  type WebglClientHandle
} from './webgl-budget'

/** A fake client that records acquire/release calls and reports a configurable acquire result. */
function fakeClient(id: string, opts: { acquireOk?: boolean } = {}) {
  const rec = { acquires: 0, releases: 0, held: false }
  const acquireOk = opts.acquireOk ?? true
  const handle: WebglClientHandle = registerWebglClient(id, {
    acquire() {
      rec.acquires++
      if (acquireOk) rec.held = true
      return acquireOk
    },
    release() {
      rec.releases++
      rec.held = false
    }
  })
  return { id, rec, handle }
}

/** Bring a client to a granted state: make it visible and let the debounce fire. */
function grant(c: ReturnType<typeof fakeClient>) {
  c.handle.setVisible(true)
  vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS)
}

describe('webgl-budget coordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetWebglBudgetForTests()
  })
  afterEach(() => {
    __resetWebglBudgetForTests()
    vi.useRealTimers()
  })

  it('grants a visible client (after debounce) when under budget', () => {
    const a = fakeClient('a')
    a.handle.setVisible(true)
    // Not yet: still inside the debounce window.
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS - 1)
    expect(a.rec.acquires).toBe(0)
    vi.advanceTimersByTime(1)
    expect(a.rec.acquires).toBe(1)
    expect(a.rec.held).toBe(true)
  })

  it('does not acquire for a client visible for less than the debounce', () => {
    const a = fakeClient('a')
    a.handle.setVisible(true)
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS - 1)
    a.handle.setVisible(false)
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS * 5)
    expect(a.rec.acquires).toBe(0)
  })

  it('reclaims the least-recently-visible hidden holder when the budget is full', () => {
    const clients = Array.from({ length: WEBGL_BUDGET }, (_, i) => fakeClient(`c${i}`))
    clients.forEach(grant)
    expect(clients.every((c) => c.rec.held)).toBe(true)

    // Hide c0 first, then c1 — c0 is now the least-recently-visible hidden holder. Both keep their
    // (warm) context for the release delay.
    clients[0].handle.setVisible(false)
    clients[1].handle.setVisible(false)
    expect(clients[0].rec.held).toBe(true)
    expect(clients[1].rec.held).toBe(true)

    // A newcomer becomes visible while the budget is still full → reclaim c0 (the LRU hidden
    // holder), bypassing its release delay, and grant the newcomer.
    const nc = fakeClient('newcomer')
    grant(nc)
    expect(clients[0].rec.releases).toBe(1) // reclaimed on demand
    expect(clients[1].rec.releases).toBe(0) // more recently visible → spared
    expect(nc.rec.held).toBe(true)
  })

  it('refuses to grant when every holder is currently visible (never exceeds budget)', () => {
    const clients = Array.from({ length: WEBGL_BUDGET }, (_, i) => fakeClient(`c${i}`))
    clients.forEach(grant)
    // All BUDGET holders are visible; a further visible client must NOT be granted (no eviction).
    const extra = fakeClient('extra')
    grant(extra)
    expect(extra.rec.acquires).toBe(0)
    expect(extra.rec.held).toBe(false)
    expect(clients.every((c) => c.rec.held)).toBe(true)
  })

  it('releases a hidden holder after the release delay', () => {
    const a = fakeClient('a')
    grant(a)
    a.handle.setVisible(false)
    vi.advanceTimersByTime(WEBGL_RELEASE_DELAY_MS - 1)
    expect(a.rec.releases).toBe(0)
    vi.advanceTimersByTime(1)
    expect(a.rec.releases).toBe(1)
    expect(a.rec.held).toBe(false)
  })

  it('cancels the pending release when a hidden holder becomes visible again', () => {
    const a = fakeClient('a')
    grant(a)
    a.handle.setVisible(false)
    vi.advanceTimersByTime(WEBGL_RELEASE_DELAY_MS - 100)
    a.handle.setVisible(true) // pan-back before the release fired
    vi.advanceTimersByTime(WEBGL_RELEASE_DELAY_MS * 2)
    expect(a.rec.releases).toBe(0)
    expect(a.rec.acquires).toBe(1) // still held, not re-acquired
    expect(a.rec.held).toBe(true)
  })

  it('frees a slot when a context is lost from outside (waiting newcomers are not auto-served)', () => {
    const clients = Array.from({ length: WEBGL_BUDGET }, (_, i) => fakeClient(`c${i}`))
    clients.forEach(grant)

    // A visible newcomer cannot be granted while full and all holders visible.
    const nc = fakeClient('nc')
    grant(nc)
    expect(nc.rec.held).toBe(false)

    // One holder's context is lost (browser eviction / our own dispose reported it).
    clients[0].handle.contextLost()

    // The freed slot is NOT auto-handed to the waiting NEWCOMER — a transition must drive it.
    // (The loser itself schedules a delayed retry; that is the next test's subject.)
    expect(nc.rec.acquires).toBe(0)

    // On the newcomer's next visibility transition it is now granted (a slot is free).
    nc.handle.setVisible(false)
    nc.handle.setVisible(true)
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS)
    expect(nc.rec.held).toBe(true)

    // The loser's own delayed retry then finds the budget full with every holder visible and
    // declines — no second acquire, and nobody is evicted for it.
    vi.advanceTimersByTime(WEBGL_REACQUIRE_AFTER_LOSS_MS)
    expect(clients[0].rec.acquires).toBe(1)
    expect(nc.rec.held).toBe(true)
  })

  it('a visible client whose context is lost externally re-acquires after the loss delay', () => {
    // The sleep/wake shape: contexts die with NO visibility change; the client must come back
    // on its own instead of sitting on the DOM renderer until the user pans away and back.
    const a = fakeClient('a')
    grant(a)
    expect(a.rec.acquires).toBe(1)

    a.handle.contextLost()
    expect(a.rec.acquires).toBe(1) // not immediate — the GPU may still be settling
    vi.advanceTimersByTime(WEBGL_REACQUIRE_AFTER_LOSS_MS)
    expect(a.rec.acquires).toBe(2)
    expect(a.rec.held).toBe(true)
  })

  it('a hidden client whose context is lost schedules no retry', () => {
    const a = fakeClient('a')
    grant(a)
    a.handle.setVisible(false)
    a.handle.contextLost()
    vi.advanceTimersByTime(WEBGL_REACQUIRE_AFTER_LOSS_MS * 2)
    expect(a.rec.acquires).toBe(1)
  })

  it('stops retrying after WEBGL_LOSS_STREAK_MAX consecutive losses; a visibility transition resets', () => {
    const a = fakeClient('a')
    grant(a)
    // Each loss within the streak retries once…
    for (let i = 0; i < WEBGL_LOSS_STREAK_MAX; i++) {
      a.handle.contextLost()
      vi.advanceTimersByTime(WEBGL_REACQUIRE_AFTER_LOSS_MS)
    }
    expect(a.rec.acquires).toBe(1 + WEBGL_LOSS_STREAK_MAX)
    // …but the loss beyond the cap gives up (unstable GPU → stay on the DOM renderer).
    a.handle.contextLost()
    vi.advanceTimersByTime(WEBGL_REACQUIRE_AFTER_LOSS_MS * 2)
    expect(a.rec.acquires).toBe(1 + WEBGL_LOSS_STREAK_MAX)

    // Panning away and back (the pre-existing recovery) resets the streak and re-grants.
    a.handle.setVisible(false)
    a.handle.setVisible(true)
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS)
    expect(a.rec.held).toBe(true)
  })

  it('dispose releases a granted context and cancels timers', () => {
    const a = fakeClient('a')
    grant(a)
    expect(a.rec.held).toBe(true)
    a.handle.dispose()
    expect(a.rec.releases).toBe(1)
    expect(a.rec.held).toBe(false)

    // A disposed client frees its slot for others.
    const others = Array.from({ length: WEBGL_BUDGET }, (_, i) => fakeClient(`o${i}`))
    others.forEach(grant)
    expect(others.every((c) => c.rec.held)).toBe(true)
  })

  it('dispose cancels a pending acquire debounce (no acquire after unmount)', () => {
    const a = fakeClient('a')
    a.handle.setVisible(true)
    a.handle.dispose()
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS * 5)
    expect(a.rec.acquires).toBe(0)
  })

  it('an acquire that returns false does not burn a budget slot', () => {
    // A client whose WebGL2 is unavailable: acquire returns false.
    const bad = fakeClient('bad', { acquireOk: false })
    grant(bad)
    expect(bad.rec.acquires).toBe(1)
    expect(bad.rec.held).toBe(false)

    // The full budget is still available to real clients.
    const clients = Array.from({ length: WEBGL_BUDGET }, (_, i) => fakeClient(`c${i}`))
    clients.forEach(grant)
    expect(clients.every((c) => c.rec.held)).toBe(true)
  })

  it('re-registering an id releases the superseded grant (no leaked context, no phantom slot)', () => {
    const a = fakeClient('dup')
    grant(a)
    expect(a.rec.acquires).toBe(1)
    // Remount races teardown: a second registration under the same id supersedes the first. The
    // predecessor's grant must be reclaimed here — its own dispose() will short-circuit (stale
    // handle), so skipping this leaks a real browser context the coordinator no longer counts.
    const b = fakeClient('dup')
    expect(a.rec.releases).toBe(1)
    a.handle.dispose() // stale handle: inert
    grant(b)
    expect(b.rec.acquires).toBe(1)
    b.handle.dispose()
  })

  it('setWebglBudget raises the grant ceiling (desktop, where the browser cap is raised too)', () => {
    setWebglBudget(WEBGL_BUDGET + 4)
    expect(getWebglBudget()).toBe(WEBGL_BUDGET + 4)
    const clients = Array.from({ length: WEBGL_BUDGET + 4 }, (_, i) => fakeClient(`c${i}`))
    clients.forEach(grant)
    expect(clients.every((c) => c.rec.held)).toBe(true)
    // The raised ceiling is still a ceiling: one more all-visible client is not granted.
    const extra = fakeClient('extra')
    grant(extra)
    expect(extra.rec.held).toBe(false)
  })

  it('setWebglBudget ignores nonsense values and reset restores the default', () => {
    setWebglBudget(0)
    expect(getWebglBudget()).toBe(WEBGL_BUDGET)
    setWebglBudget(NaN)
    expect(getWebglBudget()).toBe(WEBGL_BUDGET)
    setWebglBudget(20)
    expect(getWebglBudget()).toBe(20)
    __resetWebglBudgetForTests()
    expect(getWebglBudget()).toBe(WEBGL_BUDGET)
  })
})

describe('loseWebglContexts', () => {
  /** Canvas-like fake: getContext('webgl2') returns `gl` (or throws), anything else null. */
  function fakeCanvas(gl: unknown, opts: { throws?: boolean } = {}) {
    return {
      getContext(type: string) {
        if (opts.throws) throw new Error('boom')
        return type === 'webgl2' ? gl : null
      }
    }
  }

  it('explicitly loses the webgl2 context of every captured canvas', () => {
    const lose = vi.fn()
    const webglCanvas = fakeCanvas({ getExtension: (n: string) => (n === 'WEBGL_lose_context' ? { loseContext: lose } : null) })
    const linkCanvas = fakeCanvas(null) // 2d-only layer: getContext('webgl2') → null
    expect(loseWebglContexts([webglCanvas, linkCanvas] as never)).toBe(1)
    expect(lose).toHaveBeenCalledTimes(1)
  })

  it('fails open on a throwing canvas and a missing extension', () => {
    const bad = fakeCanvas(null, { throws: true })
    const noExt = fakeCanvas({ getExtension: () => null })
    expect(loseWebglContexts([bad, noExt] as never)).toBe(0)
  })

  it('returns 0 for a null canvas list', () => {
    expect(loseWebglContexts(null)).toBe(0)
  })
})
