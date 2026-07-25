/**
 * Pure helpers for restarting an agent CLI IN PLACE inside its tmux pane — quit the CLI, then
 * relaunch it with the provider's own `--resume`, so a newly released model shows up in the CLI's
 * model list without losing the conversation. Kept free of DOM/IPC so the node menu, the bulk
 * filter and the restart choreography can all share exactly one set of rules.
 */
import { canResume, resumeCommand } from '../../shared/agents/config'
import { deliverCommand, type DeliveryIo } from './command-delivery'

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

export type RestartOutcome = 'restarted' | 'exit-timeout' | 'not-eligible'

export const RESTART_EXIT_TIMEOUT_MS = 6000
export const RESTART_POLL_MS = 250

/**
 * In-place CLI restart: ask the agent to quit, wait until a SHELL owns the pane, then
 * echo-deliver the resume command into it. Never force-kills — on timeout the CLI is left
 * running and the caller reports the node. `paneCommand` errors count as "not a shell yet";
 * the timeout is the backstop.
 */
export async function performRestartResume(d: {
  agentId: string
  sessionId: string
  io: DeliveryIo
  paneCommand: () => Promise<string | null>
  timeoutMs?: number
  pollMs?: number
}): Promise<RestartOutcome> {
  const exit = exitSequence(d.agentId)
  const cmd = resumeCommand(d.agentId, d.sessionId)
  if (!exit || !cmd) return 'not-eligible'
  const timeoutMs = d.timeoutMs ?? RESTART_EXIT_TIMEOUT_MS
  const pollMs = d.pollMs ?? RESTART_POLL_MS
  d.io.write(exit + '\r')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs))
    let pane: string | null = null
    try {
      pane = await d.paneCommand()
    } catch {
      // transient IPC failure — keep polling until the deadline
    }
    if (isShellCommand(pane)) break
    if (Date.now() > deadline) return 'exit-timeout'
  }
  deliverCommand(d.io, cmd)
  return 'restarted'
}

// ── Node registry (same park-surviving pattern as TerminalNode's restartSubs) ────────────
const restartFns = new Map<string, () => Promise<RestartOutcome>>()

/** Register a node's restart closure; returns an unregister that is inert if superseded. */
export function registerAgentRestart(nodeId: string, fn: () => Promise<RestartOutcome>): () => void {
  restartFns.set(nodeId, fn)
  return () => {
    if (restartFns.get(nodeId) === fn) restartFns.delete(nodeId)
  }
}

export function agentRestartFn(nodeId: string): (() => Promise<RestartOutcome>) | undefined {
  return restartFns.get(nodeId)
}

/** One toast line for the bulk action; zero-count parts are omitted. */
export function summarizeOutcomes(
  outcomes: RestartOutcome[],
  skipped: { working: number; noSession: number }
): string {
  const restarted = outcomes.filter((o) => o === 'restarted').length
  const failed = outcomes.filter((o) => o === 'exit-timeout').length
  const parts = [`${restarted} restarted`]
  if (failed) parts.push(`${failed} failed (exit timeout)`)
  if (skipped.working) parts.push(`${skipped.working} skipped (working)`)
  if (skipped.noSession) parts.push(`${skipped.noSession} skipped (no session)`)
  return parts.join(' · ')
}
