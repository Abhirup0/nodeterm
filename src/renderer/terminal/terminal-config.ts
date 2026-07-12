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
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * True for the keydowns that should copy the terminal selection: Cmd+C (mac) and
 * Ctrl+Shift+C (Linux, Windows). Plain Ctrl+C is deliberately NOT one of them — it must keep
 * reaching the pty as SIGINT.
 *
 * The key is matched on the printed letter (`e.key`, so Dvorak/AZERTY follow the letter the user
 * actually presses) OR on the physical `KeyC` position (`e.code`) — on a non-Latin layout
 * (Cyrillic 'с', Greek 'ψ') `e.key` is never 'c', and without the fallback an xterm selection
 * would have no keyboard copy at all (the OS Edit menu only copies the DOM selection, not
 * xterm's canvas one).
 *
 * Cmd+Shift+C is deliberately allowed as well: nothing else binds it and it is a harmless
 * near-miss of Cmd+C. AltGr combos (which report ctrl+alt) never copy.
 */
export function isCopyShortcut(e: CopyShortcutEvent): boolean {
  if (e.type !== 'keydown') return false
  if (e.key.toLowerCase() !== 'c' && e.code !== 'KeyC') return false
  const cmdC = e.metaKey && !e.ctrlKey && !e.altKey
  const ctrlShiftC = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey
  return cmdC || ctrlShiftC
}
