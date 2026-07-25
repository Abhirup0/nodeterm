/**
 * Pure helpers for restarting an agent CLI IN PLACE inside its tmux pane — quit the CLI, then
 * relaunch it with the provider's own `--resume`, so a newly released model shows up in the CLI's
 * model list without losing the conversation. Kept free of DOM/IPC so the node menu, the bulk
 * filter and the restart choreography can all share exactly one set of rules.
 */
import { canResume } from '../../shared/agents/config'

/** In-band exit command per agent CLI. Only agents listed here can be restarted in place —
 *  an unknown CLI has no safe way to be asked to quit. */
const EXIT_SEQUENCES: Record<string, string> = { claude: '/exit', codex: '/quit' }

export function exitSequence(agentId: string): string | null {
  return EXIT_SEQUENCES[agentId] ?? null
}

/** Foreground commands that mean "the CLI is gone, a shell owns the pane". Login shells
 *  report as '-zsh'; tmux may report a full path. */
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh'])

export function isShellCommand(cmd: string | null | undefined): boolean {
  if (!cmd) return false
  const base = cmd.replace(/^-/, '').split('/').pop() ?? ''
  return SHELLS.has(base)
}

export type IneligibleReason = 'working' | 'no-session' | 'not-resumable'

/** States in which the pane must be left alone. `blocked` is here for a sharper reason than
 *  politeness: it means a permission / question dialog owns the prompt (see normalize.ts —
 *  Claude's PermissionRequest, codex's permission.asked / question.asked), so writing `/exit`
 *  would be typed AS THE ANSWER to that dialog instead of quitting the CLI. Both states report
 *  the reason `'working'`: to the user they are the same "busy, try again in a moment". */
const BUSY_STATES = new Set(['working', 'blocked'])

/** Single gate shared by the node menu, the bulk filter and the choreography itself.
 *  `not-resumable` wins over the other two: a CLI we cannot quit or resume can never be
 *  restarted, so there is nothing for the user to fix by waiting or picking another node. */
export function restartEligibility(
  agentId: string | undefined,
  state: string | undefined,
  sessionId: string | undefined
): { ok: true } | { ok: false; reason: IneligibleReason } {
  if (!agentId || !canResume(agentId) || !exitSequence(agentId))
    return { ok: false, reason: 'not-resumable' }
  // Quitting mid-turn would abandon work the agent is in the middle of; quitting a blocked
  // session would answer its dialog with the exit command (see BUSY_STATES).
  if (BUSY_STATES.has(state ?? '')) return { ok: false, reason: 'working' }
  // Without a provider session id there is nothing to resume into.
  if (!sessionId) return { ok: false, reason: 'no-session' }
  return { ok: true }
}
