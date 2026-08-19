/**
 * One shared answer to "who owns this keystroke's focus" for the global-keybinding
 * dispatcher. Replaces the three inline `tagName` guards the Canvas keydown effects carried
 * (which disagreed about contentEditable and counted xterm's hidden textarea as typing).
 *
 * **This is not the codebase's only "in terminal" notion, and the difference is the point.**
 * `presenceKeys.ts` (`closest(TYPING_ZONES)`, `.xterm` among them) and the copy gesture
 * (inline `closest('.monaco-editor, .xterm')`) both ask an ANCESTRY question, because they are
 * about a "/" keystroke or a mouse selection landing somewhere inside a terminal REGION, which
 * the `.xterm` wrapper answers and this module's class check would not.
 * DISPATCH asks a different question: who receives this keystroke. Whenever xterm owns the
 * keyboard the focused element IS the helper textarea, so the class check here is exact — and it
 * is what keeps `terminal` and `typing` disjoint (an ancestry check would report BOTH, and
 * `typing` wins, making every terminal-scope command unreachable).
 */
import type { KeyDispatchContext } from '@shared/keybindings'

/** xterm.js takes keyboard input through a hidden <textarea> with this class. Pinned against
 *  the installed dist by keyContext.test.ts — an upgrade that renames it must fail loudly. */
export const XTERM_INPUT_CLASS = 'xterm-helper-textarea'

/** Structural element shape so node-env tests need no DOM. */
export interface ContextElement {
  tagName: string
  isContentEditable?: boolean
  classList?: { contains(name: string): boolean }
}

export function isTerminalTarget(el: ContextElement | null): boolean {
  return el?.classList?.contains(XTERM_INPUT_CLASS) === true
}

/** True when the keystroke belongs to text the user is editing. The xterm textarea is
 *  deliberately excluded — a focused terminal is `terminal`, never `typing`, and the two
 *  must stay disjoint (see KeyDispatchContext). */
export function isTypingTarget(el: ContextElement | null): boolean {
  if (!el || isTerminalTarget(el)) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true
  return el.isContentEditable === true
}

/** `terminalFirst` is REQUIRED, not defaulted: it is a user policy, and a default here would let
 *  a call site silently answer "app-first" for a user who chose otherwise. Every caller decides. */
export function keyDispatchContextFor(
  el: ContextElement | null,
  kanbanOpen: boolean,
  terminalFirst: boolean
): KeyDispatchContext {
  return { typing: isTypingTarget(el), terminal: isTerminalTarget(el), kanbanOpen, terminalFirst }
}
