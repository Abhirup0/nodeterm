/**
 * Which idle agent sessions may be HIBERNATED — the pure decision half of "Eco" mode
 * (`settings.agentHibernationEnabled`). Hibernating means the agent CLI is asked to `/exit` and
 * the conversation is resumed (`--resume`) the next time the user looks at the node: the tmux
 * session, its pane and its scrollback are untouched; what is reclaimed is the CLI process's RAM.
 * The wiring that acts on this plan lives elsewhere — this module only decides.
 *
 * WHY EACH EXCLUSION EXISTS (each one is a way to lose the user's work or their attention):
 *
 *  - **Only `done`, never `waiting`** (nor `blocked`, nor an unknown state). `waiting`/`blocked`
 *    mean the CLI is holding a question or a permission request open for the user. Exiting there
 *    would SILENTLY SWALLOW A NEEDS-YOU QUESTION — the badge is exactly the thing the user is
 *    being asked to come back for, and the exit line typed into a permission prompt would ANSWER
 *    it rather than quit. `working` is refused for the obvious reason (a turn in flight), and an
 *    unknown state is not evidence of idleness.
 *  - **Never a `recurring` node** (`/loop`, `/schedule`, `/cron`, any kind). `/exit` kills the CLI
 *    PROCESS, and a loop's `ScheduleWakeup` / an in-session cron wakeup dies with it — the job
 *    would simply never fire again. Between iterations such a node looks EXACTLY like the target
 *    profile (`done`, offscreen, long idle), so this guard is the only thing standing between Eco
 *    mode and a silently cancelled recurring job.
 *  - **Never a node with live subagents.** Claude launches subagents async: the completion of an
 *    async-launched subagent is queued into the PARENT's transcript, and a dead parent CLI never
 *    reads it. Hibernating the parent orphans every subagent still running under it.
 *  - **Unknown idle is NOT idle.** A candidate with no `lastEventAt` (no hook event has ever been
 *    seen for it in this run) is never eligible — the same rule as pendingLaunch's "an unknown
 *    dependency state is not satisfied". Guessing here costs the user a live session.
 *  - **`restartEligibility` is the shared gate.** Hibernation is exit + resume, so a node this
 *    module picks must be one the restart machinery could actually bring back: a CLI we cannot
 *    quit or resume, or a session with no provider session id, has nothing to resume INTO.
 *
 * The batch cap keeps a sweep from stopping a canvas full of agents at once (each exit + resume
 * is real work in a real pane): the oldest-idle nodes go first, at most `HIBERNATE_BATCH_MAX` per
 * pass, so a long-idle backlog drains over several sweeps instead of in one storm.
 */
import { restartEligibility } from './agent-restart'

/** How many sessions one hibernation pass may take. */
export const HIBERNATE_BATCH_MAX = 2

export interface HibernationCandidate {
  id: string
  agentId?: string
  state?: string
  sessionId?: string
  /** The node has a live terminal/PTY wired up (an unwired node has nothing to exit). */
  wired: boolean
  /** The node is out of view. */
  offscreen: boolean
  /** Already hibernated — nothing left to reclaim. */
  hibernated: boolean
  /** Any `/loop`, `/schedule` or `/cron` indicator on this node (from `agentStatus.loop`). */
  recurring: boolean
  /** Any non-done subagent card whose parent is this node (from `state/agentNodes.ts`). */
  liveSubagents: boolean
  /** When this node's last hook event landed. Absent = never seen ⇒ never eligible. */
  lastEventAt?: number
}

export interface HibernationConfig {
  enabled: boolean
  idleMinutes: number
}

/** The node ids to hibernate now: oldest-idle first, at most `HIBERNATE_BATCH_MAX`. */
export function planHibernation(
  candidates: HibernationCandidate[],
  nowMs: number,
  cfg: HibernationConfig
): string[] {
  if (!cfg.enabled) return []
  // The window is re-validated HERE, not trusted from the type: settings.json is hand-editable and
  // merged without clamping, so `idleMinutes` can arrive as null, NaN, 0 or negative — and the UI
  // clamp only guards keystrokes. Each of those would make the window zero or negative, i.e. EVERY
  // done+offscreen node eligible on the first sweep: Eco exiting live CLIs the instant a turn ends.
  // So an unreadable window reads as "off" — the same call `offscreenDisposeMs` makes one file over.
  if (!(cfg.idleMinutes > 0)) return []
  const idleMs = cfg.idleMinutes * 60_000
  return candidates
    .filter(
      (c) =>
        !c.hibernated &&
        c.wired &&
        c.offscreen &&
        c.state === 'done' &&
        !c.recurring &&
        !c.liveSubagents &&
        restartEligibility(c.agentId, c.state, c.sessionId).ok &&
        // `?? Infinity`: no event ever seen ⇒ the difference is -Infinity ⇒ never eligible.
        nowMs - (c.lastEventAt ?? Infinity) >= idleMs
    )
    .sort((a, b) => (a.lastEventAt ?? 0) - (b.lastEventAt ?? 0))
    .slice(0, HIBERNATE_BATCH_MAX)
    .map((c) => c.id)
}
