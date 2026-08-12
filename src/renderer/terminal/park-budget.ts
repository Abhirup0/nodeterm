import type { AgentState } from '@shared/agents/normalize'

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

/** Agent states that mean the CLI is mid-task or holding a question open for the user. Same set
 *  hibernation refuses to `/exit` (`hibernation-policy.ts`), for the same reason: `working` is a
 *  turn in flight, `waiting`/`blocked` is a question the user is being asked to come back to. */
const LIVE_AGENT_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  'working',
  'waiting',
  'blocked'
])

export interface ParkProtectionInput {
  /**
   * The session survives losing this client — a tmux session, local or remote
   * (`PtyCreateResult.persistent`). With tmux, disposing a park KILLS ONLY OUR CLIENT: the tmux
   * session, its pane and everything running in it keep going, and the next mount is a warm
   * reattach. Without it (the plain-shell fallback — no tmux installed, tmux switched off, or a
   * tmux whose install path `findTmux` missed) the pty IS the shell, and the same dispose kills
   * the shell and every process under it.
   */
  tmuxBacked: boolean
  /** The node's live agent state (`agentStatus.byId[nodeId].state`); absent = plain terminal or
   *  no hook event seen yet. */
  agentState?: AgentState
}

/**
 * May this parked terminal be disposed by a BUDGET lever — the park window expiring, the LRU cap
 * evicting, or the memory-pressure "drop every park" lever?
 *
 * Reported (issue #126): switching projects killed a Claude agent mid-task and it came back
 * "terminated mid action", auto-resuming on return. The park is a CACHE and its dispose is
 * "detach the client", which is exactly what it costs — but only where tmux is underneath. On the
 * plain-shell fallback the very same dispose is the whole session: the shell dies, the agent CLI
 * dies with it, and the node's restart machinery resumes the conversation from wherever the kill
 * landed. Three levers reached that kill and none of them looked at what was running.
 *
 * So the protection is the narrowest one that closes it: BOTH no tmux underneath AND live agent
 * work on the node. A plain terminal, a `done`/unknown agent, and every tmux-backed session keep
 * today's behavior bit for bit.
 *
 * This is only about the budget levers. A deliberate dispose — node deleted, session closed by
 * another client, respawn into a worktree, a dead pty — goes through `disposeParkedTerminal` and
 * is never gated: there the session is already gone or is meant to be.
 */
export function canDisposePark(p: ParkProtectionInput): boolean {
  if (p.tmuxBacked) return true
  return !(p.agentState && LIVE_AGENT_STATES.has(p.agentState))
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
