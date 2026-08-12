import { describe, it, expect } from 'vitest'
import {
  PARK_MAX,
  PARK_RECHECK_MS,
  armParkExpiry,
  canDisposePark,
  disposableParks,
  planParkEviction
} from './park-budget'

describe('planParkEviction', () => {
  it('returns nothing at or under the cap', () => {
    expect(planParkEviction(['a', 'b'], 2)).toEqual([])
    expect(planParkEviction([], 2)).toEqual([])
  })
  it('evicts the oldest entries beyond the cap, oldest first', () => {
    expect(planParkEviction(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b'])
  })
  it('default cap is 12', () => {
    expect(PARK_MAX).toBe(12)
    const keys = Array.from({ length: 13 }, (_, i) => `k${i}`)
    expect(planParkEviction(keys, PARK_MAX)).toEqual(['k0'])
  })
  it('skips protected parks and takes the next disposable one instead', () => {
    // 'a' is protected → the cap is still met, by evicting the next-oldest disposable park.
    expect(planParkEviction(['a', 'b', 'c', 'd'], 2, (k) => k !== 'a')).toEqual(['b', 'c'])
  })
  it('lets the cap be exceeded rather than kill protected parks', () => {
    // Nothing disposable left: the plan is empty and the park runs over PARK_MAX. Documented
    // tradeoff — a cache overrun costs RAM, killing a plain shell costs the user's running work.
    expect(planParkEviction(['a', 'b', 'c', 'd'], 2, () => false)).toEqual([])
    expect(planParkEviction(['a', 'b', 'c', 'd'], 2, (k) => k === 'd')).toEqual(['d'])
  })
})

describe('canDisposePark', () => {
  it('protects a NON-tmux park whose agent is working/waiting/blocked', () => {
    for (const agentState of ['working', 'waiting', 'blocked'] as const) {
      expect(canDisposePark({ tmuxBacked: false, agentState })).toBe(false)
    }
  })
  it('disposes a non-tmux park whose agent is done', () => {
    expect(canDisposePark({ tmuxBacked: false, agentState: 'done' })).toBe(true)
  })
  it('disposes a non-tmux park with no agent at all (a plain terminal)', () => {
    expect(canDisposePark({ tmuxBacked: false })).toBe(true)
  })
  it('disposes a TMUX-backed park even while its agent works — the kill only detaches a client', () => {
    expect(canDisposePark({ tmuxBacked: true, agentState: 'working' })).toBe(true)
    expect(canDisposePark({ tmuxBacked: true, agentState: 'waiting' })).toBe(true)
  })
})

describe('disposableParks', () => {
  it('drops everything except the protected parks', () => {
    expect(disposableParks(['a', 'b', 'c'], (k) => k !== 'b')).toEqual(['a', 'c'])
    expect(disposableParks(['a', 'b'], () => true)).toEqual(['a', 'b'])
    expect(disposableParks(['a', 'b'], () => false)).toEqual([])
  })
})

describe('armParkExpiry', () => {
  /** Minimal injectable timer pair: fire(n) runs the nth armed callback. */
  function fakeTimers(): {
    timers: { set: (fn: () => void, ms: number) => number; clear: (h: number) => void }
    armed: Array<{ fn: () => void; ms: number; cleared: boolean }>
  } {
    const armed: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
    return {
      armed,
      timers: {
        set: (fn, ms) => armed.push({ fn, ms, cleared: false }) - 1,
        clear: (h) => {
          armed[h].cleared = true
        }
      }
    }
  }

  it('disposes when the window expires and the park is disposable', () => {
    const { timers, armed } = fakeTimers()
    let disposed = 0
    armParkExpiry(() => true, () => disposed++, 5000, timers)
    expect(armed[0].ms).toBe(5000)
    armed[0].fn()
    expect(disposed).toBe(1)
    expect(armed).toHaveLength(1) // nothing re-armed
  })

  it('re-arms at PARK_RECHECK_MS instead of disposing while the park is protected', () => {
    const { timers, armed } = fakeTimers()
    let disposable = false
    let disposed = 0
    armParkExpiry(() => disposable, () => disposed++, 5000, timers)
    armed[0].fn()
    expect(disposed).toBe(0)
    expect(armed).toHaveLength(2)
    expect(armed[1].ms).toBe(PARK_RECHECK_MS)
    // Still protected → still re-checking, never leaked into a permanent park.
    armed[1].fn()
    expect(disposed).toBe(0)
    expect(armed[2].ms).toBe(PARK_RECHECK_MS)
    // The agent finished: the next re-check disposes for real.
    disposable = true
    armed[2].fn()
    expect(disposed).toBe(1)
    expect(armed).toHaveLength(3)
  })

  it('cancel() clears the timer currently armed, re-armed or not', () => {
    const { timers, armed } = fakeTimers()
    const t = armParkExpiry(() => false, () => {}, 5000, timers)
    armed[0].fn() // re-arm
    t.cancel()
    expect(armed[0].cleared).toBe(false) // already fired; the live one is the re-armed timer
    expect(armed[1].cleared).toBe(true)
  })
})
