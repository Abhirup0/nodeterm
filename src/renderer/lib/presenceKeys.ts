// Cursor-chat key guard. "/" opens the cursor-chat input ONLY when the user is on the canvas —
// never while typing into a terminal (xterm focuses a hidden <textarea> inside .xterm), Monaco
// (.inputarea inside .monaco-editor), a chat node, or any input/contentEditable. Mirrors the
// command palette's existing activeElement guard in Canvas.tsx.
//
// Structural, not DOM-typed, so it is unit-testable under vitest's node environment. A real
// HTMLElement satisfies KeyTarget.

export interface KeyTarget {
  tagName: string
  isContentEditable?: boolean
  closest(selector: string): unknown
}

/** Cursor updates are sent at most this often (~20 Hz). */
export const CURSOR_MIN_INTERVAL_MS = 50

/** Selectors whose interior owns the keyboard — "/" must go to them, not to cursor chat. */
const TYPING_ZONES = '.xterm, .monaco-editor, .chat-node'

export function canOpenCursorChat(active: KeyTarget | null): boolean {
  if (!active) return true
  const tag = (active.tagName || '').toLowerCase()
  if (tag === 'input' || tag === 'textarea') return false
  if (active.isContentEditable) return false
  return active.closest(TYPING_ZONES) === null
}
