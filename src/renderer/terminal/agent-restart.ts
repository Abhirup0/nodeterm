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
 *
 * Resolves only once the resume line has actually LEFT the pane (deliverCommand's echo-verify
 * retries run for up to DELIVERY_ATTEMPTS × VERIFY_TIMEOUT_MS after the first write). The
 * un-submitted line is the pane's most fragile moment — anything typed into it during that window
 * is spliced into the command — so "this restart is over" must mean the delivery settled, not that
 * it was started. `guardConcurrentRestart` frees the node on exactly that boundary.
 */
export async function performRestartResume(d: {
  agentId: string
  sessionId: string
  io: DeliveryIo
  paneCommand: () => Promise<string | null>
  timeoutMs?: number
  pollMs?: number
  /**
   * Handed `deliverCommand`'s cancel the moment a delivery starts — and only then. The delivery
   * outlives this promise (it runs on its own echo-verify timers), so its lifetime belongs to
   * whoever owns the transport: a node torn down mid-restart cancels it here instead of letting
   * a retry rewrite, or the fail-open submit, land in a dead session.
   */
  onDelivery?: (cancel: () => void) => void
  /**
   * "Is the pane we are restarting still there?" — asked before the exit is written, on every
   * poll, and once more before the delivery. A session can die under a restart (the node is
   * deleted or respawned, or another client destroys the tmux session): its io then silently
   * no-ops and reporting `'restarted'` would put a phantom in the bulk summary.
   */
  isLive?: () => boolean
}): Promise<RestartOutcome> {
  const exit = exitSequence(d.agentId)
  const cmd = resumeCommand(d.agentId, d.sessionId)
  if (!exit || !cmd) return 'not-eligible'
  const timeoutMs = d.timeoutMs ?? RESTART_EXIT_TIMEOUT_MS
  const pollMs = d.pollMs ?? RESTART_POLL_MS
  // A dead session is not a restart that failed — there is no pane left to fail in. `'not-eligible'`
  // (uncounted) rather than `'exit-timeout'`, which claims something sharper and false: that the CLI
  // is still running and refused to quit, sending the user to look at a pane that is gone.
  const gone = (): boolean => !!d.isLive && !d.isLive()
  if (gone()) return 'not-eligible'
  d.io.write(exit + '\r')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs))
    let pane: string | null = null
    let lapse: ReturnType<typeof setTimeout> | undefined
    try {
      // The query must be bounded, not just its rejection: a wedged tmux server can leave it
      // pending forever, and the deadline below is only read once it settles — an unbounded
      // await would hang this restart, and with it the bulk run's summary, permanently. A
      // lapsed query resolves null, which reads as "not a shell yet".
      const remaining = Math.max(0, deadline - Date.now())
      pane = await Promise.race([
        d.paneCommand(),
        new Promise<null>((r) => {
          lapse = setTimeout(() => r(null), remaining)
        })
      ])
    } catch {
      // transient IPC failure — keep polling until the deadline
    } finally {
      clearTimeout(lapse)
    }
    if (gone()) return 'not-eligible' // stop polling a pane that no longer exists
    if (isShellCommand(pane)) break
    if (Date.now() > deadline) return 'exit-timeout'
  }
  // Awaited, not fire-and-forget: see the header. `deliverCommand` is started inside the executor
  // (synchronously, so `onDelivery` still hands the cancel out before any await) and announces the
  // end of the delivery — submitted, fail-open or cancelled — through `resolve`.
  await new Promise<void>((resolve) => {
    // Two statements on purpose: `d.onDelivery?.(deliverCommand(…))` short-circuits the ARGUMENT
    // too when no callback was passed — nothing would be delivered and this promise would never
    // settle.
    const cancelDelivery = deliverCommand(d.io, cmd, resolve)
    d.onDelivery?.(cancelDelivery)
  })
  // The session can have died while the line was being verified — the delivery is then cancelled by
  // the teardown and nothing reached the pane, so don't claim a restart.
  return gone() ? 'not-eligible' : 'restarted'
}

// ── One restart at a time, per node ──────────────────────────────────────────────────────
const inFlight = new Set<string>()

/**
 * Serialize a node's restarts. The per-node menu action and the bulk palette action can both
 * reach the same node, and two runs against one pane would write two `/exit` lines (the second
 * typed INTO the CLI the first is resuming) and two resume commands.
 *
 * The node is held for the WHOLE run, delivery included (see performRestartResume's header): a
 * second `/exit` arriving while the resume line sits un-submitted in the pane would be spliced
 * into it and submit `claude --resume <sid>/exit` — the exact mangled line command-delivery.ts
 * exists to prevent, and likeliest precisely when echo verification is being slow.
 *
 * The refused call reports `'not-eligible'` deliberately: the run already in flight owns this
 * node's outcome and will report it, and `'not-eligible'` is the one outcome `summarizeOutcomes`
 * does not count — so a doubled request is neither counted twice as restarted nor reported as a
 * failure the user could act on. (The alternative, a fifth outcome, would break that frozen line.)
 */
export function guardConcurrentRestart(
  nodeId: string,
  fn: () => Promise<RestartOutcome>
): () => Promise<RestartOutcome> {
  return async () => {
    if (inFlight.has(nodeId)) return 'not-eligible'
    inFlight.add(nodeId)
    try {
      return await fn()
    } finally {
      // Released on rejection too: a transport that threw once must not leave the node
      // permanently un-restartable for the rest of the app's run.
      inFlight.delete(nodeId)
    }
  }
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

/** TEST ONLY (house pattern: webgl-budget's `__resetWebglBudgetForTests`): both maps above are
 *  module-global, so a test that leaves a restart in flight would otherwise refuse the next
 *  test's restart of the same node id. */
export function __resetAgentRestartForTests(): void {
  inFlight.clear()
  restartFns.clear()
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
