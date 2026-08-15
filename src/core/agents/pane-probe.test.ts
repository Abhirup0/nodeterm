import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { probeWithin, PANE_PROBE_TIMEOUT_MS } from './pane-probe'

describe('probeWithin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('answers the value when the read finishes in time', async () => {
    await expect(probeWithin(async () => 'claude', 1000)).resolves.toBe('claude')
  })

  it('answers null at the deadline when the read never finishes', async () => {
    const p = probeWithin(() => new Promise<string>(() => {}), 1000)
    await vi.advanceTimersByTimeAsync(999)
    let settled = false
    void p.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false) // still waiting — the bound is a deadline, not a poll
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toBeNull()
  })

  it('answers null when the read throws, rather than rejecting into the main process', async () => {
    await expect(
      probeWithin(async () => {
        throw new Error('ssh: connection closed')
      }, 1000)
    ).resolves.toBeNull()
  })

  it('answers null when the read rejects asynchronously too', async () => {
    await expect(probeWithin(() => Promise.reject(new Error('EPIPE')), 1000)).resolves.toBeNull()
  })

  it('gives each call its own deadline — a slow one does not shorten the next', async () => {
    const slow = probeWithin(() => new Promise<string>(() => {}), 1000)
    await vi.advanceTimersByTimeAsync(900)
    const second = probeWithin(() => new Promise<string>(() => {}), 1000)
    await vi.advanceTimersByTimeAsync(100)
    await expect(slow).resolves.toBeNull()

    let secondSettled = false
    void second.then(() => {
      secondSettled = true
    })
    await Promise.resolve()
    expect(secondSettled).toBe(false) // 900ms of its own 1000 still to run
    await vi.advanceTimersByTimeAsync(900)
    await expect(second).resolves.toBeNull()
  })

  it('does not hold a timer open after a fast answer', async () => {
    await expect(probeWithin(async () => 42, 60_000)).resolves.toBe(42)
    // A live 60s timer here would keep the process (and, under fake timers, the suite) waiting.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('defaults to the gate deadline, which is bounded in seconds not minutes', async () => {
    const p = probeWithin(() => new Promise<string>(() => {}))
    await vi.advanceTimersByTimeAsync(PANE_PROBE_TIMEOUT_MS)
    await expect(p).resolves.toBeNull()
    expect(PANE_PROBE_TIMEOUT_MS).toBe(2000)
  })
})
