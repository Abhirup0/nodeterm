import { describe, it, expect } from 'vitest'
import { canOpenCursorChat, type KeyTarget } from './presenceKeys'

/** A stand-in for document.activeElement (an HTMLElement structurally satisfies KeyTarget). */
function target(tagName: string, opts: { editable?: boolean; inside?: string[] } = {}): KeyTarget {
  const inside = opts.inside ?? []
  return {
    tagName,
    isContentEditable: !!opts.editable,
    closest: (sel: string) =>
      inside.some((cls) => sel.includes(cls)) ? ({} as unknown as KeyTarget) : null
  }
}

describe('canOpenCursorChat', () => {
  it('opens on the bare canvas (nothing focused, or the body/pane is focused)', () => {
    expect(canOpenCursorChat(null)).toBe(true)
    expect(canOpenCursorChat(target('BODY'))).toBe(true)
    expect(canOpenCursorChat(target('DIV'))).toBe(true)
  })

  it('never steals "/" from a text field', () => {
    expect(canOpenCursorChat(target('INPUT'))).toBe(false)
    expect(canOpenCursorChat(target('TEXTAREA'))).toBe(false)
    expect(canOpenCursorChat(target('DIV', { editable: true }))).toBe(false)
  })

  it('never steals "/" from a terminal, Monaco, or a chat node (xterm focuses a hidden textarea; Monaco an .inputarea)', () => {
    expect(canOpenCursorChat(target('TEXTAREA', { inside: ['.xterm'] }))).toBe(false)
    expect(canOpenCursorChat(target('DIV', { inside: ['.xterm'] }))).toBe(false)
    expect(canOpenCursorChat(target('DIV', { inside: ['.monaco-editor'] }))).toBe(false)
    expect(canOpenCursorChat(target('DIV', { inside: ['.chat-node'] }))).toBe(false)
  })
})
