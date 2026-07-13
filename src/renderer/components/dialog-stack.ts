/**
 * The open-modal stack — which dialog owns the keyboard.
 *
 * Every `ConfirmDialog` is a portal to `document.body` and listens on `window` for Enter/Escape.
 * With two of them mounted, the LATER one paints on top (portals append in mount order) while the
 * earlier one stays live and invisible underneath — and BOTH window listeners fired, so a single
 * Enter aimed at the dialog the user could actually see also answered the one they could not. That
 * was reachable purely from an agent: a `close-worktree --mode remove` (delete dialog, "delete from
 * disk" pre-ticked) immediately followed by a benign `write` (Send dialog on top) turned the user's
 * Enter on "Send" into a worktree deletion.
 *
 * Keys therefore belong to the TOP of this stack and to nothing else. Mount order is the stack
 * order, which is exactly the paint order, so "topmost" is always the dialog the user is looking at.
 *
 * Module state, not React state: the check runs inside a window keydown handler, and a dialog that
 * must decide "is this key mine?" cannot wait for a re-render to find out.
 */

const stack: string[] = []
let seq = 0

/** A fresh id for one dialog instance (kept in a ref for the life of the component). */
export function nextDialogId(): string {
  seq += 1
  return `dialog-${seq}`
}

/** Register a dialog as open (call on mount). Idempotent. */
export function pushDialog(id: string): void {
  if (!stack.includes(id)) stack.push(id)
}

/** Unregister a dialog (call on unmount). Removing a non-top id keeps the rest in order. */
export function popDialog(id: string): void {
  const i = stack.indexOf(id)
  if (i !== -1) stack.splice(i, 1)
}

/** Does this dialog own the keyboard? Only the most recently mounted one does. */
export function isTopDialog(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id
}

/** How many modal dialogs are currently open (tests / diagnostics). */
export function openDialogCount(): number {
  return stack.length
}

/** Tests only: forget every registration. */
export function resetDialogStack(): void {
  stack.length = 0
}
