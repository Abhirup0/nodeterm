import { describe, it, expect, beforeEach } from 'vitest'
import {
  PAIR_MIN_INTERVAL_MS,
  FANOUT_PER_TURN,
  FANOUT_RETRY_AFTER_MS,
  TURN_STALE_MS,
  checkFanOut,
  checkFlowLimits,
  checkPairRate,
  flowStats,
  noteNewTurn,
  noteSent,
  pairKey,
  reserveFlow,
  resetMessageFlow,
  type FlowVerdict
} from './agent-message-flow'
import { decidePreProbe, RETRYABLE } from './agent-message-decide'
import { deliverAgentMessage, type DeliveryDeps } from './agent-message'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import { isSafeNodeId } from '../remote-safety'
import type { MirrorEntry } from '../agent-status-mirror'

const T0 = 1_700_000_000_000

/** The `retryAfterMs` of a refusal, or `null` when the verdict was `ok`. Asserted by RUNNING the
 *  checks — nothing in this file reads the module's source. */
const wait = (v: FlowVerdict): number | null => ('ok' in v ? null : v.retryAfterMs)

beforeEach(() => resetMessageFlow())

describe('the per-pair rate limit', () => {
  it('lets the first delivery of a pair through', () => {
    expect(wait(checkPairRate('a', 'b', T0))).toBeNull()
  })

  it('refuses the second inside the window, and the wait is the exact remainder', () => {
    noteSent('a', 'b', T0)
    expect(wait(checkPairRate('a', 'b', T0 + 1))).toBe(PAIR_MIN_INTERVAL_MS - 1)
    expect(wait(checkPairRate('a', 'b', T0 + 4000))).toBe(PAIR_MIN_INTERVAL_MS - 4000)
    expect(wait(checkPairRate('a', 'b', T0 + PAIR_MIN_INTERVAL_MS - 1))).toBe(1)
  })

  it('opens again exactly AT the interval, not one tick later', () => {
    noteSent('a', 'b', T0)
    expect(wait(checkPairRate('a', 'b', T0 + PAIR_MIN_INTERVAL_MS - 1))).toBe(1)
    expect(wait(checkPairRate('a', 'b', T0 + PAIR_MIN_INTERVAL_MS))).toBeNull()
  })

  it('throttles the PAIR, not the sender: A→B says nothing about A→C', () => {
    // The failure this pins: keyed by sender alone, an orchestrator fanning out to four workers
    // starves itself — three of its four sends are refused for being correct behaviour.
    noteSent('a', 'b', T0)
    expect(wait(checkPairRate('a', 'c', T0 + 1))).toBeNull()
    expect(wait(checkPairRate('a', 'b', T0 + 1))).toBe(PAIR_MIN_INTERVAL_MS - 1)
  })

  it('throttles the PAIR, not the target: A→B says nothing about C→B', () => {
    // The failure this pins: keyed by target alone, one node's window is held shut by whoever
    // wrote to it last, and every other conversation with that node pays for it.
    noteSent('a', 'b', T0)
    expect(wait(checkPairRate('c', 'b', T0 + 1))).toBeNull()
  })

  it('the REVERSE pair is a different pair — a reply is never throttled by the message it answers', () => {
    noteSent('a', 'b', T0)
    expect(wait(checkPairRate('b', 'a', T0 + 1))).toBeNull()
    // …and the reply's own window is likewise the reply's own.
    noteSent('b', 'a', T0 + 1)
    expect(wait(checkPairRate('b', 'a', T0 + 2))).toBe(PAIR_MIN_INTERVAL_MS - 1)
    expect(wait(checkPairRate('a', 'b', T0 + 2))).toBe(PAIR_MIN_INTERVAL_MS - 2)
  })

  it('the key composes both ids so no two distinct conversations share one', () => {
    // The separator is a NUL because a node id cannot contain one. A hyphen or a space could:
    // 'a-b'\u2192'c' and 'a'\u2192'b-c' would be the SAME key under either, and one conversation
    // would silently throttle another.
    // The set must contain ids that DO collide under a weaker key, or this proves nothing: 'ab'+'c'
    // and 'a'+'bc' are the same string once the separator is dropped. (Found by mutation: without
    // these four the whole test stayed green with the separator removed entirely.)
    const ids = ['a', 'b', 'c', 'ab', 'bc', 'a-b', 'b-c', 'a b', 'b c']
    const seen = new Map<string, string>()
    for (const src of ids)
      for (const dst of ids) {
        const key = pairKey(src, dst)
        const pair = `${src}\u2192${dst}`
        expect(seen.get(key) ?? pair, `${seen.get(key)} collided with ${pair}`).toBe(pair)
        seen.set(key, pair)
      }
    expect(seen.size).toBe(ids.length * ids.length)
    // The reverse pair in particular — the one people get wrong.
    expect(pairKey('a', 'b')).not.toBe(pairKey('b', 'a'))
  })

  it('an id CONTAINING the separator would collide two conversations — and is refused upstream', () => {
    // The uniqueness test above cannot see this: no id in its set can contain a NUL, so the shape
    // moves one layer down instead of dying. Here it is, exhibited rather than asserted away — and
    // then the validator that makes the premise true, refusing exactly the ids that cause it.
    const SEP = String.fromCharCode(0)
    expect(pairKey(`x${SEP}y`, 'z')).toBe(pairKey('x', `y${SEP}z`))
    noteSent(`x${SEP}y`, 'z', T0)
    // …a live mis-throttle: a conversation nobody has had is refused for 9999 ms.
    expect(wait(checkPairRate('x', `y${SEP}z`, T0 + 1))).toBe(PAIR_MIN_INTERVAL_MS - 1)
    // Node ids are not validated on the project.json load path, so the premise is enforced at the
    // authorization boundary instead — `resolveDeliveryScope`, over this predicate.
    expect(isSafeNodeId(`x${SEP}y`)).toBe(false)
    expect(isSafeNodeId('x y')).toBe(false)
    expect(isSafeNodeId('v/1')).toBe(false)
    expect(isSafeNodeId('term-mabc-3')).toBe(true)
  })

  it('a CHECK never starts a window — only a delivered message does', () => {
    // Otherwise a delivery refused for any other reason (a busy target, an unverified identity —
    // the two commonest refusals there are) would burn the budget it never used, and the caller
    // told to retry would be rate-limited for doing what it was told.
    expect(wait(checkPairRate('a', 'b', T0))).toBeNull()
    expect(wait(checkPairRate('a', 'b', T0 + 1))).toBeNull()
    expect(flowStats().pairs).toBe(0)
  })
})

describe('the per-turn fan-out cap', () => {
  it('passes FANOUT_PER_TURN deliveries in one turn and refuses the next', () => {
    // Four DIFFERENT targets, so nothing here can be the per-pair limiter firing.
    for (let i = 0; i < FANOUT_PER_TURN; i++) {
      expect(wait(checkFanOut('a', T0 + i)), `send ${i + 1} of the turn`).toBeNull()
      noteSent('a', `dst-${i}`, T0 + i)
    }
    expect(wait(checkFanOut('a', T0 + FANOUT_PER_TURN))).toBe(FANOUT_RETRY_AFTER_MS)
  })

  it("resets on the SOURCE's own newTurn", () => {
    for (let i = 0; i < FANOUT_PER_TURN; i++) noteSent('a', `dst-${i}`, T0 + i)
    expect(wait(checkFanOut('a', T0 + 10))).toBe(FANOUT_RETRY_AFTER_MS)
    noteNewTurn('a')
    expect(wait(checkFanOut('a', T0 + 10))).toBeNull()
  })

  it("another node's newTurn does not reset it", () => {
    // If it did, every delivery would refill the budget that sent it: a delivery is precisely what
    // starts the TARGET's next turn.
    for (let i = 0; i < FANOUT_PER_TURN; i++) noteSent('a', `dst-${i}`, T0 + i)
    noteNewTurn('b')
    noteNewTurn('dst-0')
    expect(wait(checkFanOut('a', T0 + 10))).toBe(FANOUT_RETRY_AFTER_MS)
  })

  it('a tool-event burst does not reset it — nothing but a newTurn does', () => {
    // The renderer's own per-turn fan-out is keyed on `newTurn` for this reason: a working→done→
    // working cycle happens many times inside one turn. This module is given no state signal at
    // all, so the assertion is that everything else it accepts leaves the budget standing.
    for (let i = 0; i < FANOUT_PER_TURN; i++) noteSent('a', `dst-${i}`, T0 + i)
    for (let t = 1; t < 60; t++) {
      checkFanOut('a', T0 + t * 1000)
      checkPairRate('a', 'dst-0', T0 + t * 1000)
      noteNewTurn('someone-else')
    }
    // Still inside the same turn (well under TURN_STALE_MS), still capped.
    expect(wait(checkFanOut('a', T0 + 60_000))).toBe(FANOUT_RETRY_AFTER_MS)
  })

  it('the budget is per SENDER: one node using it up does not silence another', () => {
    for (let i = 0; i < FANOUT_PER_TURN; i++) noteSent('a', `dst-${i}`, T0 + i)
    expect(wait(checkFanOut('a', T0 + 10))).toBe(FANOUT_RETRY_AFTER_MS)
    expect(wait(checkFanOut('b', T0 + 10))).toBeNull()
  })

  it('expires on its own if the turn signal never arrives — the stuck-limiter backstop', () => {
    // A shell that never wires `noteNewTurn` would otherwise silence every sender after four
    // messages, for the rest of the run, with no way to wait it out.
    for (let i = 0; i < FANOUT_PER_TURN; i++) noteSent('a', `dst-${i}`, T0 + i)
    const lastSend = T0 + FANOUT_PER_TURN - 1
    expect(wait(checkFanOut('a', lastSend + TURN_STALE_MS - 1))).toBe(FANOUT_RETRY_AFTER_MS)
    expect(wait(checkFanOut('a', lastSend + TURN_STALE_MS))).toBeNull()
  })

  it('the backstop measures the LAST send, not the first — a slow turn is still capped', () => {
    noteSent('a', 'dst-0', T0)
    for (let i = 1; i < FANOUT_PER_TURN; i++) noteSent('a', `dst-${i}`, T0 + i * (TURN_STALE_MS - 1))
    const last = T0 + (FANOUT_PER_TURN - 1) * (TURN_STALE_MS - 1)
    expect(wait(checkFanOut('a', last + 1))).toBe(FANOUT_RETRY_AFTER_MS)
  })
})

describe('the refusals are the union member, and they refuse for real', () => {
  it('a fan-out refusal survives the trip through decidePreProbe', () => {
    // The trap: `decidePreProbe` refuses on `retryAfterMs > 0`, so a cap reporting 0 would be a cap
    // that silently stopped existing. Asserted by running the decider on the number this module
    // actually produces.
    for (let i = 0; i < FANOUT_PER_TURN; i++) noteSent('a', `dst-${i}`, T0 + i)
    const v = checkFanOut('a', T0 + 10)
    expect('ok' in v).toBe(false)
    const outcome = decidePreProbe({
      targetLive: true,
      tokenFilePresent: true,
      target: { state: 'done', updatedAt: T0, stateVerified: true, clientRevision: MANAGED_SCRIPT_REVISION },
      retryAfterMs: (v as { retryAfterMs: number }).retryAfterMs
    })
    expect(outcome).toEqual({ kind: 'rateLimited', retryAfterMs: FANOUT_RETRY_AFTER_MS })
    expect(RETRYABLE.rateLimited).toBe(true)
  })

  it('a pair refusal likewise, with its own remaining wait', () => {
    noteSent('a', 'b', T0)
    const v = checkPairRate('a', 'b', T0 + 2500)
    const outcome = decidePreProbe({
      targetLive: true,
      tokenFilePresent: true,
      target: { state: 'done', updatedAt: T0, stateVerified: true, clientRevision: MANAGED_SCRIPT_REVISION },
      retryAfterMs: (v as { retryAfterMs: number }).retryAfterMs
    })
    expect(outcome).toEqual({ kind: 'rateLimited', retryAfterMs: PAIR_MIN_INTERVAL_MS - 2500 })
  })
})

describe('checkFlowLimits — both budgets in one call', () => {
  it('passes when both do', () => {
    expect(checkFlowLimits('a', 'b', T0)).toEqual({ ok: true })
  })

  it('names the pair limit when only the pair is over', () => {
    noteSent('a', 'b', T0)
    expect(checkFlowLimits('a', 'b', T0 + 1)).toEqual({
      ok: false,
      limit: 'pair',
      outcome: { kind: 'rateLimited', retryAfterMs: PAIR_MIN_INTERVAL_MS - 1 }
    })
  })

  it('names the fan-out cap when only the cap is over', () => {
    for (let i = 0; i < FANOUT_PER_TURN; i++) noteSent('a', `dst-${i}`, T0 + i)
    expect(checkFlowLimits('a', 'fresh-target', T0 + 10)).toEqual({
      ok: false,
      limit: 'fan-out',
      outcome: { kind: 'rateLimited', retryAfterMs: FANOUT_RETRY_AFTER_MS }
    })
  })

  it('reports the FAN-OUT cap when both refuse — its wait is never the shorter one', () => {
    for (let i = 0; i < FANOUT_PER_TURN; i++) noteSent('a', `dst-${i}`, T0 + i)
    // dst-0's pair window has 2 ms left; the fan-out floor is the whole interval. Reporting the
    // smaller of two live limits would invite a retry that is already known to fail.
    const nearlyOpen = T0 + PAIR_MIN_INTERVAL_MS - 2
    expect(checkFlowLimits('a', 'dst-0', nearlyOpen)).toEqual({
      ok: false,
      limit: 'fan-out',
      outcome: { kind: 'rateLimited', retryAfterMs: FANOUT_RETRY_AFTER_MS }
    })
  })

  it('and the precedence is only sound while the fan-out floor is the longer wait', () => {
    // The invariant behind the branch above, pinned so that changing either constant fails here
    // rather than silently telling a caller to come back before it can be served.
    expect(FANOUT_RETRY_AFTER_MS).toBeGreaterThanOrEqual(PAIR_MIN_INTERVAL_MS)
  })
})

describe('eviction — the entries go away, not just the verdicts', () => {
  it('drops a pair entry once its window has passed', () => {
    // Asserted on the MAP, not through a read that shares the window's bound: a limiter that
    // decides expiry at read time while the map keeps growing passes every verdict test and leaks.
    noteSent('a', 'b', T0)
    noteSent('c', 'd', T0)
    expect(flowStats().pairs).toBe(2)
    checkPairRate('x', 'y', T0 + PAIR_MIN_INTERVAL_MS)
    expect(flowStats().pairs).toBe(0)
  })

  it('keeps a pair entry that is still inside its window', () => {
    noteSent('a', 'b', T0)
    checkPairRate('x', 'y', T0 + PAIR_MIN_INTERVAL_MS - 1)
    expect(flowStats().pairs).toBe(1)
  })

  it('drops a sender budget once it goes stale, and on a newTurn', () => {
    noteSent('a', 'b', T0)
    expect(flowStats().senders).toBe(1)
    noteNewTurn('a')
    expect(flowStats().senders).toBe(0)
    noteSent('a', 'b', T0)
    checkFanOut('z', T0 + TURN_STALE_MS)
    expect(flowStats().senders).toBe(0)
  })

  it('a clock that jumps BACKWARDS drops the entry instead of parking it in the future', () => {
    // An NTP step back would otherwise leave `PAIR_MIN_INTERVAL_MS - (now - at)` refusing for as
    // long as the step was large — an agent silenced for an hour by a time correction. Over-sending
    // by one message is the direction this module always takes.
    noteSent('a', 'b', T0)
    expect(wait(checkPairRate('a', 'b', T0 - 60 * 60_000))).toBeNull()
    expect(flowStats().pairs).toBe(0)
    for (let i = 0; i < FANOUT_PER_TURN; i++) noteSent('a', `dst-${i}`, T0 + i)
    expect(wait(checkFanOut('a', T0 - 60 * 60_000))).toBeNull()
    expect(flowStats().senders).toBe(0)
  })

  it('a NON-FINITE clock reading empties both maps instead of freezing them', () => {
    // Every comparison in the sweep is FALSE for NaN, so without the guard the entry is immortal —
    // and the two budgets then fail in opposite directions: the pair limiter's `retryAfterMs` is
    // NaN (which `decidePreProbe` reads as "no limit", so it fails open) while the fan-out cap
    // keeps returning a real number forever, silencing the sender for the rest of the run.
    for (let i = 0; i < FANOUT_PER_TURN; i++) noteSent('a', `dst-${i}`, T0 + i)
    expect(wait(checkFanOut('a', T0 + 10))).toBe(FANOUT_RETRY_AFTER_MS)
    expect(wait(checkFanOut('a', Number.NaN))).toBeNull()
    expect(flowStats()).toEqual({ pairs: 0, senders: 0 })
    // …and the budget is genuinely released rather than merely reported open once.
    expect(wait(checkFanOut('a', T0 + 11))).toBeNull()
    expect(wait(checkPairRate('a', 'dst-0', T0 + 11))).toBeNull()
  })

  it('an INFINITE reading is safe too, though not because of that guard', () => {
    // Measured, not assumed: +Infinity is dropped by the staleness arm and -Infinity by the future
    // arm, so swapping `!Number.isFinite` for `Number.isNaN` is an EQUIVALENT mutation. NaN is the
    // one value both comparisons are false for, which is what the previous test pins.
    noteSent('a', 'b', T0)
    expect(wait(checkPairRate('a', 'b', Number.POSITIVE_INFINITY))).toBeNull()
    expect(flowStats()).toEqual({ pairs: 0, senders: 0 })
    noteSent('a', 'b', T0)
    expect(wait(checkPairRate('a', 'b', Number.NEGATIVE_INFINITY))).toBeNull()
    expect(flowStats()).toEqual({ pairs: 0, senders: 0 })
  })

  it('resetMessageFlow really empties both maps', () => {
    noteSent('a', 'b', T0)
    resetMessageFlow()
    expect(flowStats()).toEqual({ pairs: 0, senders: 0 })
    expect(wait(checkPairRate('a', 'b', T0 + 1))).toBeNull()
  })
})

describe('the limiter is consulted BEFORE any pane probe', () => {
  // The point of a pre-probe refusal: on an SSH project whose ControlMaster has died, a probe is a
  // real login, and a busy-looping sender turns that into the 72k-logins/day shape this repo has
  // already lived through. Asserted by RUNNING a delivery with a probe that counts its calls.
  const idle: MirrorEntry = {
    state: 'done',
    updatedAt: T0,
    stateVerified: true,
    clientRevision: MANAGED_SCRIPT_REVISION
  }

  function countingDeps(): { deps: DeliveryDeps; probes: number[]; writes: number[] } {
    const probes: number[] = []
    const writes: number[] = []
    return {
      probes,
      writes,
      deps: {
        paneOwner: async () => {
          probes.push(1)
          return null
        },
        bracketPasteRequested: async () => true,
        sendEnvelope: async () => {
          writes.push(1)
          return true
        },
        mirrorEntry: () => idle,
        tokenFilePresent: () => true,
        lock: async (_id, fn) => fn(),
        now: () => T0,
        nonce: () => 'NONCE0123456',
        trace: async () => ({ traceId: 't-1', traced: 'memory' as const }),
        subscribeEvents: () => () => {}
      }
    }
  }

  it('a rate-limited delivery touches no pane and writes nothing', async () => {
    noteSent('n-src', 'n-dst', T0)
    const check = checkFlowLimits('n-src', 'n-dst', T0 + 1)
    expect(check.ok).toBe(false)
    const { deps, probes, writes } = countingDeps()
    const outcome = await deliverAgentMessage(
      {
        targetNodeId: 'n-dst',
        sourceNodeId: 'n-src',
        sourceTitle: 'Alpha',
        body: 'do the thing',
        targetAgentId: 'claude',
        retryAfterMs: (check as { outcome: { retryAfterMs: number } }).outcome.retryAfterMs
      },
      deps
    )
    expect(outcome).toEqual({ kind: 'rateLimited', retryAfterMs: PAIR_MIN_INTERVAL_MS - 1 })
    expect(probes).toEqual([])
    expect(writes).toEqual([])
  })

  it('and the same delivery DOES probe once the budget is clear — the counter is real', async () => {
    // The control. Without it the assertion above would pass just as well against a delivery that
    // never probes anything, which would make it evidence of nothing.
    expect(wait(checkPairRate('n-src', 'n-dst', T0))).toBeNull()
    const { deps, probes, writes } = countingDeps()
    const outcome = await deliverAgentMessage(
      {
        targetNodeId: 'n-dst',
        sourceNodeId: 'n-src',
        sourceTitle: 'Alpha',
        body: 'do the thing',
        targetAgentId: 'claude'
      },
      deps
    )
    expect(probes.length).toBe(1)
    // An unreadable pane is refused, so still no write — the probe is the thing being counted.
    expect(outcome).toEqual({ kind: 'targetPaneUnreadable' })
    expect(writes).toEqual([])
  })
})

/**
 * The RESERVATION — what makes check+record atomic across a sender's CONCURRENT deliveries.
 *
 * `checkFlowLimits` is a pure read and `noteSent` records only after the pane write, so N parallel
 * sends to N DISTINCT targets all used to pass the fan-out cap before any of them recorded — the
 * cap held only for a sender polite enough to send sequentially. `reserveFlow` closes that: the
 * check and the provisional hold happen in one synchronous step (no await between them, which in a
 * single-threaded runtime IS the critical section), and a delivery that never reaches the pane
 * releases its hold.
 */
describe('reserveFlow — check + provisional hold, atomically', () => {
  const NOW = 1_000_000

  it('N reservations to distinct targets consume the fan-out budget BEFORE any noteSent', () => {
    const held: { release(): void }[] = []
    for (let i = 0; i < FANOUT_PER_TURN; i++) {
      const r = reserveFlow('src', `t${i}`, NOW)
      expect(r.ok, `reservation ${i}`).toBe(true)
      if (r.ok) held.push(r)
    }
    // The (N+1)th concurrent send is refused although NOTHING has been recorded yet.
    const over = reserveFlow('src', 'tN', NOW)
    expect(over.ok).toBe(false)
    if (!over.ok) {
      expect(over.limit).toBe('fan-out')
      expect(over.outcome).toEqual({ kind: 'rateLimited', retryAfterMs: FANOUT_RETRY_AFTER_MS })
    }
    for (const r of held) r.release()
  })

  it('a released reservation restores the budget — a refused delivery costs nothing', () => {
    const rs = Array.from({ length: FANOUT_PER_TURN }, (_, i) => reserveFlow('src', `t${i}`, NOW))
    for (const r of rs) if (r.ok) r.release()
    expect(reserveFlow('src', 'late', NOW).ok).toBe(true)
  })

  it('reservations and recorded sends SHARE the budget', () => {
    noteSent('src', 'a', NOW)
    noteSent('src', 'b', NOW)
    const r1 = reserveFlow('src', 'c', NOW)
    const r2 = reserveFlow('src', 'd', NOW)
    expect(r1.ok && r2.ok).toBe(true)
    expect(reserveFlow('src', 'e', NOW).ok).toBe(false)
  })

  it('an in-flight delivery holds its PAIR shut too — a concurrent same-pair send is rateLimited', () => {
    const r = reserveFlow('src', 'dst', NOW)
    expect(r.ok).toBe(true)
    const second = reserveFlow('src', 'dst', NOW)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.limit).toBe('pair')
    // …and B→A stays open: a reply is never throttled by the message it answers.
    expect(reserveFlow('dst', 'src', NOW).ok).toBe(true)
  })

  it('release is idempotent — a finally block calling it twice cannot free a stranger\'s slot', () => {
    const a = reserveFlow('src', 'a', NOW)
    const b = reserveFlow('src', 'b', NOW)
    expect(a.ok && b.ok).toBe(true)
    if (a.ok) {
      a.release()
      a.release()
    }
    // Only ONE slot came back (b still holds): three more fill the cap of FANOUT_PER_TURN = 4,
    // and the next refuses. A double release that freed two would let the fifth through.
    const c = reserveFlow('src', 'c', NOW)
    const d = reserveFlow('src', 'd', NOW)
    const e = reserveFlow('src', 'e', NOW)
    expect(c.ok && d.ok && e.ok).toBe(true)
    expect(reserveFlow('src', 'f', NOW).ok).toBe(false)
    for (const r of [b, c, d, e]) if (r.ok) r.release()
  })
})
