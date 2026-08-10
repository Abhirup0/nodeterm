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
