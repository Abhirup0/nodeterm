/**
 * WHICH KEY MAY ANSWER A CONFIRM DIALOG — the primitive, pure and testable.
 *
 * The dialog listens on `window` (a portal, no focus trap), so every keystroke in the app reaches
 * it — including the ones the user aimed at a terminal, a chat box, a rename field or the command
 * palette. None of those are dialogs, so the one-at-a-time / dialog-stack guards are not even
 * engaged for them. That was enough to destroy data:
 *
 *   1. the user is typing into a terminal;
 *   2. an agent calls `close-worktree --mode remove` → the removal dialog mounts, with "delete from
 *      disk" pre-ticked for an app-created worktree, and `autoFocus` on the DELETE button silently
 *      steals focus off the terminal;
 *   3. the user finishes their thought and presses Enter → the window listener fires → the worktree
 *      directory (uncommitted work included) and its branch are gone.
 *
 * So a keystroke must satisfy ALL of the following before it can CONFIRM:
 *  - `top`          — this is the dialog the user can actually see (./dialog-stack);
 *  - `inDialog`     — the key was aimed HERE (its target is inside this dialog's own DOM), not at
 *                     the terminal that happened to have focus;
 *  - `!repeat`      — a key the user is holding down is not an answer;
 *  - `armed`        — the dialog has been on screen for CONFIRM_ARM_MS; a dialog that appears
 *                     underneath an in-flight keystroke must not be able to catch it;
 *  - `enterConfirms`— the user OPENED this dialog. One the app raised on someone else's behalf (an
 *                     agent verb) is answered by an explicit click, never by a stray Enter.
 *
 * ESCAPE is deliberately laxer: it only ever CANCELS, so the worst it can do is make the user ask
 * again. It needs `top` and nothing else.
 */

/** How long a freshly mounted dialog ignores confirmations (ms). Long enough to cover a keystroke
 *  already on its way when the dialog appeared; short enough to be invisible to a real user. */
export const CONFIRM_ARM_MS = 500

export interface ConfirmKeyContext {
  key: string
  /** `KeyboardEvent.repeat` — the user is holding the key down. */
  repeat: boolean
  /** Is this dialog the topmost one (the one being painted for the user)? */
  top: boolean
  /** Was the event's target inside this dialog's own DOM subtree? */
  inDialog: boolean
  /** ms since this dialog mounted. */
  sinceMount: number
  /** May Enter confirm this dialog at all? False for a dialog the user did not open. */
  enterConfirms: boolean
}

/** The action a keydown may take on this dialog — or `null` (the key is not ours; do not even
 *  preventDefault it, the terminal/input it was aimed at still has to see it). */
export function confirmKeyAction(c: ConfirmKeyContext): 'confirm' | 'cancel' | null {
  if (!c.top) return null
  if (c.key === 'Escape') return 'cancel'
  if (c.key !== 'Enter') return null
  if (c.repeat) return null
  if (!c.enterConfirms) return null
  if (!c.inDialog) return null
  if (c.sinceMount < CONFIRM_ARM_MS) return null
  return 'confirm'
}
