// Tracks whether a zoom modifier (Cmd/Ctrl) is currently held, via a single set of
// capture-phase window listeners. Used by the terminal hover-guard so Cmd+wheel zooming over
// a terminal doesn't dwell-focus (enter) the terminal — the canvas keeps zooming instead.
let held = false
let inited = false

function ensure(): void {
  if (inited) return
  inited = true
  const down = (e: KeyboardEvent) => {
    if (e.key === 'Meta' || e.key === 'Control' || e.metaKey || e.ctrlKey) held = true
  }
  const up = (e: KeyboardEvent) => {
    if (e.key === 'Meta' || e.key === 'Control') held = false
    else if (!e.metaKey && !e.ctrlKey) held = false
  }
  window.addEventListener('keydown', down, true)
  window.addEventListener('keyup', up, true)
  window.addEventListener('blur', () => (held = false))
}

/** True while Cmd or Ctrl is currently pressed. */
export function isZoomModifierHeld(): boolean {
  ensure()
  return held
}
