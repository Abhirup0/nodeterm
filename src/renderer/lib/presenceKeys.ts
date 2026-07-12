// Pure helpers for the presence cursor layer (PresenceLayer.tsx): the cursor-chat key guard and
// the zoom counter-scale. Kept out of the component because vitest runs in the node environment
// (no jsdom), so a React component cannot be unit-tested — these can.
//
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

/**
 * The arrow tip's offset (px, at 1×) inside the cursor svg — the `transform-origin` of the
 * counter-scale, so scaling pivots on the TIP and it keeps pointing at the peer's exact flow
 * coordinate at any zoom. Must track the `M2 2 …` start of the arrow path in PresenceLayer.
 */
export const CURSOR_HOTSPOT_PX = 2

/** How far below-right of the anchor the local cursor-chat input sits (px, screen space). */
export const CHAT_ANCHOR_OFFSET_PX = 16

/**
 * The transform that cancels the canvas zoom for a peer's cursor chrome (arrow, name label, chat
 * bubble). Cursors live inside the ViewportPortal so their POSITION is in flow space (they stick
 * to the node they point at) — but their SIZE must stay constant on screen, Figma-style: at 0.2×
 * an un-scaled name label is unreadable, at 2× it is oversized. Hence 1/zoom.
 *
 * Rounded to 4 decimals so a zoom tick can't emit a 17-digit style string, and defensive about a
 * zoom of 0 / negative / non-finite (React Flow never reports one; a `scale(Infinity)` would blow
 * the layer up to nothing).
 */
export function counterScale(zoom: number): string {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  return `scale(${Math.round((1 / z) * 1e4) / 1e4})`
}
