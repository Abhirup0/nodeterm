/**
 * When to tear down an OFFSCREEN terminal's xterm+PTY client in place (node stays mounted; the
 * tmux session keeps running and re-attach redraws — same contract as the Refresh action and the
 * post-park remount). cmux's renderer-realization idea taken one level deeper: past this window
 * nobody has looked at the node for so long that reattach-redraw fidelity is indistinguishable
 * from park fidelity, and the buffer (up to ~16 MB full) is pure cost.
 *
 * REMOTE (SSH) nodes are excluded in v1: their spawn path runs the requireRemote/offline
 * machinery and a re-spawn while the ControlMaster is down would surface the offline overlay for
 * a node the user never touched. Follow-up once demand exists.
 */
import type { SessionSource } from '../session/session'

export const OFFSCREEN_DISPOSE_MS_DEFAULT = 10 * 60_000

/**
 * Does this node's CORE live on another machine? That — not the node's own fields — is what decides
 * whether a revive would run a spawn across a link that can be down.
 *
 * Asked of the session the node renders under, because that is where the answer actually is: a
 * relay tab's terminals run on the paired desktop, a remote-server tab's on that server, and
 * neither node carries a field saying so (`data.ssh`/`data.sshRemoteTmux` describe an SSH PROJECT,
 * which is a different thing and is asked separately). `'local'` covers the Electron app AND the
 * Server Edition's own browser session — the core is at the other end of a preload or a
 * same-machine websocket, always up when the UI is, so those stay eligible.
 */
export function offscreenCoreIsRemote(source: SessionSource): boolean {
  return source !== 'local'
}

/** Setting is in minutes; 0 or negative = feature off; undefined = default. */
export function offscreenDisposeMs(settingMinutes: number | undefined): number | null {
  if (settingMinutes === undefined) return OFFSCREEN_DISPOSE_MS_DEFAULT
  if (!(settingMinutes > 0)) return null
  return Math.round(settingMinutes * 60_000)
}

export function mayDisposeOffscreen(i: {
  visible: boolean
  remote: boolean
  selected: boolean
}): boolean {
  return !i.visible && !i.remote && !i.selected
}

/** How often a DEFERRED release re-asks. The hibernation sweep's own cadence, because that is
 *  exactly what the deferral is waiting for: one sweep after the node hibernates, the viewer goes. */
export const OFFSCREEN_DEFER_RETRY_MS = 60_000

/**
 * PHASE 5 ORDERING: with Eco on, releasing an offscreen terminal's viewer WAITS for its agent to
 * hibernate first.
 *
 * The two features want the same node and they are not equal prizes. This release reclaims the
 * xterm buffer and the PTY client — roughly 15 MB at the top end. Hibernation reclaims the agent
 * CLI PROCESS, which is hundreds of MB. But the release UNWIRES the node (the lifecycle effect
 * tears down, so the hibernate pair is unregistered and `planHibernation` reads the node as
 * unwired), and at the shipped defaults it fires FIRST — 10 minutes offscreen against a 30-minute
 * idle window. The canonical case the whole feature exists for, "finish a turn and pan away",
 * therefore never hibernated at all: the small prize was taken in a way that forfeited the large
 * one. So the release defers, and the ordering becomes hibernate-then-release; once the CLI is
 * gone, the pane holds a plain shell and the viewer release is a pure win on top.
 *
 * The deferral is CAPPED, and the cap is why this cannot strand anything: a node that will never
 * hibernate — a `/cron` node, one with a live subagent, an agent with no session id yet — must not
 * hold its viewer forever waiting for something that is not coming. Past
 * `idleMinutes + offscreenMinutes` the release proceeds regardless, so the worst case is that a
 * non-hibernating node keeps its buffer for the sum of the two windows instead of one of them.
 *
 * Deliberately NOT gated on "this node is currently eligible": eligibility is a moving target
 * (a working node goes done, a session id arrives late), and asking for it here would re-implement
 * `planHibernation` in a second place. The question asked is the durable one — could this node's
 * CLI ever be quit and resumed at all — and the cap covers the rest.
 */
export function shouldDeferReleaseForEco(i: {
  ecoEnabled: boolean
  /** Is this an agent whose CLI this app can quit AND resume? (Anything else can never hibernate.) */
  resumableAgent: boolean
  /** Already hibernated — the CLI is gone, so the release is now a pure win and must proceed. */
  hibernated: boolean
  /** How long this node has been continuously out of view. */
  offscreenElapsedMs: number
  idleMinutes: number
  offscreenMinutes: number
}): boolean {
  if (!i.ecoEnabled || !i.resumableAgent || i.hibernated) return false
  // An unusable window means Eco is off in practice (`planHibernation` refuses a non-positive one),
  // so there is nothing to wait for — release on the ordinary schedule.
  if (!(i.idleMinutes > 0)) return false
  const cap = (i.idleMinutes + Math.max(0, i.offscreenMinutes)) * 60_000
  return i.offscreenElapsedMs < cap
}

/** What a visibility report owes the offscreen state machine. Pure so the node only has to run it. */
export interface OffscreenPlan {
  /** Drop the pending dispose timer (it is armed and no longer wanted). */
  cancelTimer: boolean
  /** Arm the dispose timer for `offscreenDisposeMs`. */
  armTimer: boolean
  /** Come back up: clear the down flag and re-run the lifecycle effect (fresh warm attach). */
  revive: boolean
}

/**
 * The whole down/up decision, given the observer's latest verdict.
 *
 * Visible always wins immediately — a node the user is looking at must never sit behind the plate
 * waiting for a timer — and re-arming is refused while `down` (there is nothing left to dispose)
 * or while a timer is already armed (the observer fires on every intersection change, and a
 * re-arm per fire would push the deadline out forever on a canvas that is being panned).
 * `disposeMs === null` is the feature switched off: nothing is ever armed, but a node that is
 * ALREADY down still revives, so flipping the setting to 0 can never strand a disposed terminal.
 */
export function planOffscreenVisibility(i: {
  visible: boolean
  down: boolean
  timerArmed: boolean
  disposeMs: number | null
}): OffscreenPlan {
  if (i.visible) return { cancelTimer: i.timerArmed, armTimer: false, revive: i.down }
  return {
    cancelTimer: false,
    armTimer: i.disposeMs !== null && !i.down && !i.timerArmed,
    revive: false
  }
}
