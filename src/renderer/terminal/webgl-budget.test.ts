import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerWebglClient,
  __resetWebglBudgetForTests,
  WEBGL_ACQUIRE_DEBOUNCE_MS,
  WEBGL_BUDGET,
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

  it('frees a slot when a context is lost from outside (no auto-re-grant)', () => {
    const clients = Array.from({ length: WEBGL_BUDGET }, (_, i) => fakeClient(`c${i}`))
    clients.forEach(grant)

    // A visible newcomer cannot be granted while full and all holders visible.
    const nc = fakeClient('nc')
    grant(nc)
    expect(nc.rec.held).toBe(false)

    // One holder's context is lost (browser eviction / our own dispose reported it).
    clients[0].handle.contextLost()

    // The freed slot is NOT auto-handed to the waiting newcomer — a transition must drive it.
    expect(nc.rec.acquires).toBe(0)

    // On the newcomer's next visibility transition it is now granted (a slot is free).
    nc.handle.setVisible(false)
    nc.handle.setVisible(true)
    vi.advanceTimersByTime(WEBGL_ACQUIRE_DEBOUNCE_MS)
    expect(nc.rec.held).toBe(true)
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
})
