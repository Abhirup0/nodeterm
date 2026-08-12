/**
 * THE ONE QUESTION EVERY MEMORY LEVER MUST ASK BEFORE IT KILLS A PTY CLIENT: would that kill end
 * work the user has running?
 *
 * The renderer reclaims terminal memory in four places, and all four are written as if dropping a
 * PTY client were free — "the tmux session keeps running and re-attach redraws". That sentence is
 * true only where tmux is actually underneath. On the plain-shell fallback (no tmux installed,
 * tmux switched off in settings, or an install path `findTmux` missed) the pty IS the shell, so
 * the identical call kills the shell and every process under it — an agent CLI mid-turn included.
 *
 * Reported as issue #126: switching projects terminated a working Claude agent, which then
 * auto-resumed from wherever the kill landed ("terminated mid action"). Three of the four levers
 * are the park's (window expiry, LRU cap, memory-pressure drop — see `park-budget.ts`); the fourth
 * is the offscreen viewer release (`offscreen-policy.ts`). They differ in everything except this
 * question, which is why it lives here on its own rather than in whichever module happened to
 * need it first.
 *
 * The predicate is deliberately the NARROWEST one that closes the bug: it takes both halves, and
 * either half alone leaves today's behavior untouched. A tmux-backed session is never protected
 * (the kill costs a redraw, and protecting it would forfeit real memory on the setups where
 * reclaiming it is free); a plain terminal, a finished agent and an unknown state are never
 * protected either (nothing is running to lose).
 */
import type { AgentState } from '@shared/agents/normalize'

/**
 * Agent states that mean the CLI is mid-task or holding something open for the user. The same set
 * hibernation refuses to `/exit` (`hibernation-policy.ts`) and for the same reasons: `working` is
 * a turn in flight, `waiting`/`blocked` is a question or a permission request the user is being
 * asked to come back for. `done` and unknown are not evidence of live work.
 */
const LIVE_AGENT_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  'working',
  'waiting',
  'blocked'
])

export interface LiveWorkInput {
  /**
   * The session survives losing this client — a tmux session, local or remote
   * (`PtyCreateResult.persistent`). False = the plain-shell fallback, where the pty is the shell.
   */
  tmuxBacked: boolean
  /** The node's live agent state (`agentStatus.byId[nodeId].state`); absent = a plain terminal, or
   *  no hook event seen for it yet. */
  agentState?: AgentState
}

/** Would tearing down this terminal's PTY client destroy work that is still running? */
export function wouldKillLiveWork(i: LiveWorkInput): boolean {
  return !i.tmuxBacked && !!i.agentState && LIVE_AGENT_STATES.has(i.agentState)
}
