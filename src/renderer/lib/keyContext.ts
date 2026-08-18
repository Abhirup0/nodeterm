/**
 * One shared answer to "who owns this keystroke's focus" for the global-keybinding
 * dispatcher. Replaces the three inline `tagName` guards the Canvas keydown effects carried
 * (which disagreed about contentEditable and counted xterm's hidden textarea as typing).
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

export function keyDispatchContextFor(
  el: ContextElement | null,
  kanbanOpen: boolean
): KeyDispatchContext {
  return { typing: isTypingTarget(el), terminal: isTerminalTarget(el), kanbanOpen }
}
