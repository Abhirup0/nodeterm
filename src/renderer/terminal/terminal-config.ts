/**
 * Pure decisions behind the xterm instance in `TerminalNode` — extracted so they can be
 * tested without an xterm/DOM harness.
 */

/** Hard cap on xterm's in-memory scrollback: the cost is per node and one canvas holds many. */
export const XTERM_SCROLLBACK_MAX = 10000

/**
 * How many scrollback lines xterm keeps. Scrolling is xterm's job now (tmux's mouse is off),
 * so it needs a real scrollback — xterm's default is only 1000 lines. It follows the same
 * `settings.tmuxScrollback` the user picked for tmux's history-limit, but capped.
 */
export function xtermScrollback(tmuxScrollback: number): number {
  return Math.min(tmuxScrollback, XTERM_SCROLLBACK_MAX)
}

/** The subset of a KeyboardEvent the copy-shortcut decision looks at. */
export interface CopyShortcutEvent {
  type: string
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * True for the keydowns that should copy the terminal selection: Cmd+C (mac) and
 * Ctrl+Shift+C (Linux, Windows). Plain Ctrl+C is deliberately NOT one of them — it must keep
 * reaching the pty as SIGINT.
 */
export function isCopyShortcut(e: CopyShortcutEvent): boolean {
  if (e.type !== 'keydown') return false
  const key = e.key.toLowerCase()
  if (key !== 'c') return false
  const cmdC = e.metaKey && !e.ctrlKey && !e.altKey
  const ctrlShiftC = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey
  return cmdC || ctrlShiftC
}
