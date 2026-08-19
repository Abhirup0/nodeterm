// Personal pin for the Explorer drawer. Same storage family as the sessions sidebar
// (`nodeterm.sessionsPinned`) and the tree's expanded dirs (`nodeterm.explorerExpanded`):
// this machine only, never settings.json / project.json.
//
// Default OFF. Sessions defaulted on because it launched as a docked panel; Explorer is a
// modal overlay today, and flipping the default would dock it on every existing user's next
// launch. The pin is opt-in: once set, the next launch reopens the drawer already docked.
//
// Three flags, same shape as the sessions sidebar:
//   pinned    — persisted preference
//   dismissed — transient "hide for now" (the ×). Does NOT clear the pin.
//   open      — unpinned (modal) visibility
//
// There is no hover-peek: unpinning a visible drawer keeps it as the modal so the tree the
// user was looking at does not vanish. Overlay click-outside closes only the modal; a pinned
// drawer that still sat under a full-screen overlay would STEAL canvas clicks even if the
// handler no-op'd — so the overlay must also stop capturing pointer events (CSS).

export const EXPLORER_PINNED_KEY = 'nodeterm.explorerPinned'

export interface ExplorerPinState {
  pinned: boolean
  dismissed: boolean
  open: boolean
}

/** `'1'` is pinned; missing, `'0'`, or any other value is unpinned. */
export function parseExplorerPinned(raw: string | null): boolean {
  return raw === '1'
}

export function readExplorerPinned(
  getItem: (key: string) => string | null = (key) => localStorage.getItem(key)
): boolean {
  try {
    return parseExplorerPinned(getItem(EXPLORER_PINNED_KEY))
  } catch {
    return false
  }
}

export function writeExplorerPinned(
  pinned: boolean,
  setItem: (key: string, value: string) => void = (key, value) => localStorage.setItem(key, value)
): void {
  try {
    setItem(EXPLORER_PINNED_KEY, pinned ? '1' : '0')
  } catch {
    /* private-mode / quota: pin is a nicety, never fail the UI */
  }
}

/** Pin docks it; dismissed is a transient hide. Unpinned uses `open` as the modal flag. */
export function explorerIsOpen(state: ExplorerPinState): boolean {
  return state.pinned ? !state.dismissed : state.open
}

/** Click-outside on the scrim closes the modal only. A pinned drawer has no scrim close. */
export function explorerOverlayClickCloses(pinned: boolean): boolean {
  return !pinned
}

export type ExplorerShowAction = 'open' | 'toggle' | 'close' | 'reveal'

export function nextExplorerShow(
  state: ExplorerPinState,
  action: ExplorerShowAction
): Pick<ExplorerPinState, 'dismissed' | 'open'> {
  if (action === 'close') return { dismissed: true, open: false }
  if (action === 'toggle' && explorerIsOpen(state)) return { dismissed: true, open: false }
  // open / reveal / toggle-from-hidden: show, keep the pin
  return { dismissed: false, open: true }
}

/**
 * Flip the pin. (Re)pinning always shows the docked panel. Unpinning a visible drawer
 * becomes the modal (`open: true`) even if `open` was still false — that is the
 * launch-pinned case: `pinned && !dismissed` showed it without ever setting `open`.
 */
export function nextExplorerPin(state: ExplorerPinState): ExplorerPinState {
  if (!state.pinned) {
    return { pinned: true, dismissed: false, open: true }
  }
  return { pinned: false, dismissed: false, open: explorerIsOpen(state) }
}
