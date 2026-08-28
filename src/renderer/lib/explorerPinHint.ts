// One-shot discoverability hint for the Explorer pin (user feedback via email): people open a
// file from the (unpinned, modal) Explorer, click into the new editor node, and the drawer
// closes under them — not knowing the pin in its header would have kept it docked. The pin has
// existed since lib/explorerPin.ts; this hint only makes it findable at the exact moment the
// close bites.
//
// Personal, machine-local flag (same storage family as `nodeterm.seenSelectHint`): localStorage,
// so the Server Edition keeps it per-user/browser and settings.json is untouched.

export const EXPLORER_PIN_HINT_KEY = 'nodeterm.seenExplorerPinHint'

export const EXPLORER_PIN_HINT_TEXT =
  'Tip: the Explorer closes when you click away. Pin it (📌 in its header) to keep it open while you work.'

/**
 * Show the hint exactly once, and only when the close is the one that hurts: the drawer just
 * went from open to closed, it was UNPINNED (a pinned drawer never closes on click-away, and
 * its owner already knows the pin), and a file was opened from it during this open-spell —
 * a browse-and-dismiss close teaches nothing about pinning.
 */
export function shouldShowExplorerPinHint(args: {
  wasOpen: boolean
  isOpenAfter: boolean
  pinned: boolean
  openedFile: boolean
  seen: boolean
}): boolean {
  return args.wasOpen && !args.isOpenAfter && !args.pinned && args.openedFile && !args.seen
}

export function readSeenExplorerPinHint(
  getItem: (key: string) => string | null = (key) => localStorage.getItem(key)
): boolean {
  try {
    return getItem(EXPLORER_PIN_HINT_KEY) === '1'
  } catch {
    // Unreadable storage (private mode): claim "seen" — better to lose a nicety than to show
    // the "one-shot" hint on every close forever.
    return true
  }
}

export function writeSeenExplorerPinHint(
  setItem: (key: string, value: string) => void = (key, value) => localStorage.setItem(key, value)
): void {
  try {
    setItem(EXPLORER_PIN_HINT_KEY, '1')
  } catch {
    /* quota / private mode: the hint is a nicety, never fail the UI */
  }
}
