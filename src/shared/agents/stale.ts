// ONE rule, three surfaces.
//
// A session leaves `working` only when something says so — and some exits say nothing at all: Esc
// during a tool call (Claude's Stop hook never runs), a killed CLI, a slept machine, a dropped SSH.
// Whatever is watching then shows a session working forever: the node badge's RUNNING, the notch
// capsule's walking mascot, and — worst, because it sits on a Lock Screen you aren't looking at —
// the phone's Live Activity.
//
// Each surface used to invent its own timeout (30 min in the renderer store, 20 in the notch, none
// at all on the phone). This module is the single number, and `core/agent-status-mirror.ts` is the
// single DECIDER: its sweep fires one synthetic end edge per stale node, which every consumer of
// `onNodeStateChange` already knows how to handle.

/**
 * How long a `working` node may go without any event before it is presumed gone.
 *
 * Well past a real gap between hook events — Claude's Bash tool caps out around 10 minutes, and
 * every tool call refreshes the entry — so a genuinely long turn is never swept. And the sweep is
 * self-healing anyway: one later event puts the node straight back into `working`.
 */
export const WORKING_STALE_MS = 20 * 60_000

/** Has a `working` node gone quiet for longer than the window? Pure; `now` is injected. */
export function isStaleWorking(
  state: string | undefined,
  updatedAt: number,
  now: number,
  staleMs: number = WORKING_STALE_MS
): boolean {
  return state === 'working' && now - updatedAt > staleMs
}
