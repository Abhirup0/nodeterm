/** The MIDDLE mouse button, as `MouseEvent.button` numbers it (0 left, 1 middle, 2 right). */
const MIDDLE_BUTTON = 1

/**
 * Should this mouse event be swallowed before xterm can see it?
 *
 * Pure, so the rule can be pinned without a DOM. It is one line and still worth naming, because
 * the two halves are easy to get backwards: `allow` is the user's setting for "middle click may
 * paste", so suppressing is what happens when it is OFF.
 */
export function suppressMiddleClickPaste(button: number, allow: boolean): boolean {
  return button === MIDDLE_BUTTON && !allow
}

/**
 * Stop a middle click inside a terminal pasting text into the pty (issue #84, Linux).
 *
 * WHAT IS ACTUALLY HAPPENING — measured on the reporting machine (Ubuntu/GNOME/Wayland, CDP probe
 * with three distinct markers, issue #84 follow-up). The paste does NOT come from the browser. A
 * middle click produces only `mousedown`/`mouseup`/`auxclick` on xterm's canvas — no `paste`, no
 * `beforeinput`, no `input`, and the hidden textarea is never the target. xterm forwards a mouse
 * report for the middle button, and something DOWNSTREAM of the pty consumes it:
 *
 *  - at a plain shell prompt, tmux's root binding (`MouseDown2Pane` → `paste-buffer`) pastes
 *    TMUX's buffer — usually empty, which is why nothing visible happened there;
 *  - under an agent TUI, tmux passes the report through (`send-keys -M`) and the TUI itself reads
 *    the X PRIMARY selection — whatever was last selected anywhere on the machine lands in a live
 *    agent prompt, which is where the bug actually hurt.
 *
 * (The first version of this file told a different story — Blink pasting PRIMARY into the hidden
 * textarea xterm keeps under the cursor. That mechanism was refuted by the measurement above: no
 * paste event ever fires, and a CDP-synthesized middle click pastes nothing. It may still exist on
 * setups we have not measured, which is the only reason `preventDefault` is kept below.)
 *
 * WHY `preventDefault` ALONE COULD NOT WORK: there is no browser default action in this path, so
 * there was nothing to cancel — the first fix shipped exactly that and was confirmed inert on the
 * reporting machine. The event's only role is to reach xterm's own listeners, which turn it into
 * the mouse report. So the working lever is PROPAGATION: stop the event in the CAPTURE phase on
 * the host, before xterm's listeners (attached on descendants) ever run, and no report is
 * forwarded. There is no narrower hook — xterm.js exposes no public handler for mouse buttons
 * (only `attachCustomKeyEventHandler` / `attachCustomWheelEventHandler`).
 *
 * THE CONSEQUENCE THE SETTING MUST OWN: tmux and the TUI consume the SAME forwarded report, so
 * suppressing it kills tmux's own middle-click paste too. With the setting OFF, the middle button
 * is fully INERT inside a terminal — not "the browser doesn't paste", but "a middle click does
 * nothing here". That is the behaviour the reporter asked for; the Settings copy says the same.
 *
 * `mousedown` is in the list because that is where xterm emits the report. `mouseup`/`auxclick`
 * stay so the release half of the gesture cannot leak either (and `preventDefault` covers a real
 * Blink paste path if one exists elsewhere — it costs nothing). `stopImmediatePropagation` also
 * silences later listeners on the host itself, not just descendants.
 *
 * `allow` is read at EVENT TIME, not at attach time, so flipping the setting takes effect on the
 * next click instead of on the next terminal.
 */
export function guardMiddleClickPaste(host: HTMLElement, allow: () => boolean): () => void {
  const onEvent = (e: MouseEvent): void => {
    if (!suppressMiddleClickPaste(e.button, allow())) return
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
  }
  host.addEventListener('mousedown', onEvent, true)
  host.addEventListener('mouseup', onEvent, true)
  host.addEventListener('auxclick', onEvent, true)
  return () => {
    host.removeEventListener('mousedown', onEvent, true)
    host.removeEventListener('mouseup', onEvent, true)
    host.removeEventListener('auxclick', onEvent, true)
  }
}
