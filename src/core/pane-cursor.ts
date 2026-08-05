import type { PaneCursor } from '@shared/types'

/**
 * Parse tmux's `display-message -p '#{cursor_x} #{cursor_y} #{cursor_flag}'` reply.
 *
 * Its own module, and pure, because it is the one part of the cursor-restore path that can be
 * tested without a tmux: the rest is a subprocess call. What it has to get right is not the happy
 * case but the REFUSALS — a reply that is not three numbers must produce `undefined`, because the
 * caller's fallback (leave the cursor where the paint left it) is merely the old behaviour, while a
 * half-parsed answer would place the cursor somewhere the pane never had it.
 *
 * Things that legitimately arrive here and are not a cursor: the empty string (a dead
 * ControlMaster, a session that just died), tmux's own error text on stdout ("can't find pane"),
 * and a format string echoed back verbatim by a tmux too old to know a field. All refused.
 *
 * `cursor_flag` is tmux's "does the application want the cursor shown" bit — 1 or 0. It is read
 * strictly: anything else refuses the whole reply rather than guessing a visibility, since guessing
 * wrong either hides a cursor the user needs or paints one over a full-screen TUI that hid it.
 */
export function parsePaneCursor(reply: string): PaneCursor | undefined {
  const parts = reply.trim().split(/\s+/)
  if (parts.length !== 3) return undefined
  const x = Number(parts[0])
  const y = Number(parts[1])
  // `Number('')` is 0 and `Number('1x')` is NaN — the integer check covers both, and the
  // non-negative check covers a tmux that reports -1 for "no cursor here".
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return undefined
  if (parts[2] !== '0' && parts[2] !== '1') return undefined
  return { x, y, visible: parts[2] === '1' }
}
