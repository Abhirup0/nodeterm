/** The MIDDLE mouse button, as `MouseEvent.button` numbers it (0 left, 1 middle, 2 right). */
const MIDDLE_BUTTON = 1

/**
 * Should this mouse event's DEFAULT ACTION be suppressed?
 *
 * Pure, so the rule can be pinned without a DOM. It is one line and still worth naming, because
 * the two halves are easy to get backwards: `allow` is the user's setting for "middle click may
 * paste", so suppressing is what happens when it is OFF.
 */
export function suppressMiddleClickPaste(button: number, allow: boolean): boolean {
  return button === MIDDLE_BUTTON && !allow
}

/**
 * Stop Chromium pasting the X PRIMARY selection into a terminal on middle click.
 *
 * WHAT IS ACTUALLY HAPPENING (issue #84, Ubuntu/GNOME, nodeterm 0.2.37). xterm keeps a one-cell
 * hidden `textarea` positioned under the cursor. On Linux, Blink pastes the PRIMARY selection into
 * an editable element on middle-button release — so a middle click over that textarea injects
 * whatever was last selected ANYWHERE on the machine straight into the pty. Three things make it
 * worth suppressing rather than living with:
 *
 *  - The user cannot turn it off. Chromium honours the desktop's `gtk-enable-primary-paste` in its
 *    own Views widgets, not in web content, so the GNOME setting reading `false` changes nothing.
 *  - It fires hardest exactly where it hurts. The textarea tracks the CURSOR, so in an agent TUI —
 *    whose input box is where the pointer already is — a stray click lands text in a live prompt.
 *    At a plain shell prompt the cursor is at the end of the line and the click usually misses.
 *  - It is not a path this app ever built. Nothing here routes it, gates it or shows it to the
 *    user; it is the browser reaching around the terminal.
 *
 * WHAT THIS DOES NOT TOUCH: tmux's own middle-click paste. That is a tmux root binding
 * (`MouseDown2Pane` → `paste-buffer`) pasting TMUX's buffer, and it is delivered through mouse
 * tracking — it never involved the browser, and preventing a default action does not stop xterm
 * forwarding the event. The issue reporter unbound it on a live server and the paste continued,
 * which is what identified Blink as the source.
 *
 * BOTH `mouseup` AND `auxclick`, in the CAPTURE phase. Blink triggers the paste on RELEASE, and the
 * two events are separate cancelation points on the same gesture; taking both is cheap and removes
 * any question of which one the platform actually honours. `mousedown` is deliberately NOT included
 * — nothing to gain, and preventing a default that early is the sort of thing that quietly breaks
 * focus handling.
 *
 * `allow` is read at EVENT TIME, not at attach time, so flipping the setting takes effect on the
 * next click instead of on the next terminal.
 */
export function guardMiddleClickPaste(host: HTMLElement, allow: () => boolean): () => void {
  const onEvent = (e: MouseEvent): void => {
    if (suppressMiddleClickPaste(e.button, allow())) e.preventDefault()
  }
  host.addEventListener('mouseup', onEvent, true)
  host.addEventListener('auxclick', onEvent, true)
  return () => {
    host.removeEventListener('mouseup', onEvent, true)
    host.removeEventListener('auxclick', onEvent, true)
  }
}
