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
export const OFFSCREEN_DISPOSE_MS_DEFAULT = 10 * 60_000

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
