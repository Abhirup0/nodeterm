import { wouldKillLiveWork, type LiveWorkInput } from './live-work'

/**
 * Count cap for parked terminals (see TerminalNode's parkedTerminals). The park window
 * (TERM_PARK_MS) bounds each entry in TIME but nothing bounded the COUNT: switching through N
 * projects inside the window parked every terminal of each — each holding a full xterm buffer
 * with a live PTY subscription. Evicting the oldest park is invisible to the user: a disposed
 * park just means the next remount is a warm tmux reattach (tmux redraws), the same path every
 * remount after the 5-minute window already takes.
 *
 * 12 ≈ one busy project's worth of terminals; the same order of magnitude as WEBGL_BUDGET.
 */
export const PARK_MAX = 12

/**
 * How long a PROTECTED park (see `canDisposePark`) waits before asking again whether it may be
 * disposed. A protection must never turn a park into a permanent leak, so an expiry it blocks
 * RE-ARMS rather than being cancelled — the park is disposed the first re-check after the agent
 * stops working.
 *
 * A minute, matching the hibernation sweep's cadence (HIBERNATE_SWEEP_MS) and for the same
 * reason: the re-check is a Map lookup plus a store read, but what it waits for is a human-scale
 * event (an agent turn ending), so a faster poll would only pay for an answer that cannot have
 * changed. The cost of the coarseness is bounded and small — one already-parked xterm held at
 * most a minute past the moment it became disposable.
 */
export const PARK_RECHECK_MS = 60_000

/**
 * May this parked terminal be disposed by a BUDGET lever — the park window expiring, the LRU cap
 * evicting, or the memory-pressure "drop every park" lever?
 *
 * The park's name for the shared safety question (`wouldKillLiveWork`, see `live-work.ts`): its
 * dispose is "detach the client", which is exactly what a cache eviction should cost — but only
 * where tmux is underneath. On the plain-shell fallback the very same dispose is the whole
 * session, so a park holding a working agent there is protected (issue #126).
 *
 * This is only about the budget levers. A deliberate dispose — node deleted, session closed by
 * another client, respawn into a worktree, a dead pty — goes through `disposeParkedTerminal` and
 * is never gated: there the session is already gone or is meant to be.
 */
export function canDisposePark(p: LiveWorkInput): boolean {
  return !wouldKillLiveWork(p)
}

/** Keys to dispose so the park stays within `max`, oldest first. Caller passes keys in park
 *  order (Map insertion order — TerminalNode always deletes before re-inserting on re-park).
 *
 *  `canDispose` (default: everything) is the live-work protection above. A protected park is
 *  SKIPPED, not counted out: the plan takes the next-oldest disposable park instead, so the cap
 *  still holds whenever anything may be dropped at all. When it cannot — every park protected —
 *  THE CAP YIELDS: the plan comes back short and the park runs over `max`. That is the same value
 *  judgment hibernation's exclusions make (a bounded cache overrun costs RAM; killing a plain
 *  shell costs the user's running work), and it is self-limiting: each protected park is released
 *  by its own expiry re-check (PARK_RECHECK_MS) as soon as its agent stops. */
export function planParkEviction(
  keysInParkOrder: string[],
  max: number,
  canDispose: (key: string) => boolean = () => true
): string[] {
  const overflow = keysInParkOrder.length - max
  if (overflow <= 0) return []
  const plan: string[] = []
  for (const key of keysInParkOrder) {
    if (plan.length >= overflow) break
    if (canDispose(key)) plan.push(key)
  }
  return plan
}

/** The parks the memory-pressure lever may drop: everything except the protected ones. */
export function disposableParks(keys: string[], canDispose: (key: string) => boolean): string[] {
  return keys.filter(canDispose)
}

/** A park's expiry timer. Opaque because it RE-ARMS (see `armParkExpiry`), so the handle the
 *  caller must eventually clear is not the one it started with. */
export interface ParkTimer {
  cancel(): void
}

interface ParkTimers<H> {
  set(fn: () => void, ms: number): H
  clear(handle: H): void
}

/**
 * Arm the park window, RE-ARMING at `PARK_RECHECK_MS` for as long as `canDispose` says no.
 *
 * The re-arm is the whole point: a protection that merely skipped the dispose would leak the
 * park forever (no other timer would ever look at it again), and one that cancelled itself would
 * hold a live agent's xterm until the app closed. Instead an expiry that finds live work
 * postpones itself, and the park is disposed on the first re-check after the agent goes idle.
 *
 * `timers` is injectable so the re-arm is testable without real time; production passes none.
 */
export function armParkExpiry<H>(
  canDispose: () => boolean,
  dispose: () => void,
  windowMs: number,
  timers: ParkTimers<H> = {
    set: (fn, ms) => setTimeout(fn, ms) as unknown as H,
    clear: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>)
  }
): ParkTimer {
  const tick = (): void => {
    if (canDispose()) {
      dispose()
      return
    }
    handle = timers.set(tick, PARK_RECHECK_MS)
  }
  let handle = timers.set(tick, windowMs)
  return { cancel: () => timers.clear(handle) }
}
