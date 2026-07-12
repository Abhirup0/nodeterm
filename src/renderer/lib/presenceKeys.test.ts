import { describe, it, expect } from 'vitest'
import { canOpenCursorChat, counterScale, type KeyTarget } from './presenceKeys'

/**
 * A stand-in for document.activeElement (an HTMLElement structurally satisfies KeyTarget).
 * `inside` lists the selectors of the element's ancestors (plus itself).
 *
 * The stub parses the selector list the way a real `closest` does — split on commas, match WHOLE
 * selectors — deliberately: a substring match (`sel.includes('.xterm')`) would also report a hit
 * for a compound/descendant selector like `.xterm .monaco-editor`, i.e. an implementation that is
 * broken in a real DOM would pass here. vitest runs in the node environment (no jsdom), so this
 * stub is the only DOM contract the guard is tested against — it has to be an honest one.
 */
function target(tagName: string, opts: { editable?: boolean; inside?: string[] } = {}): KeyTarget {
  const inside = opts.inside ?? []
  return {
    tagName,
    isContentEditable: !!opts.editable,
    closest: (sel: string) => {
      const selectors = sel
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      return selectors.some((s) => inside.includes(s)) ? ({} as unknown as KeyTarget) : null
    }
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

  it('opens inside ordinary canvas chrome (an unrelated ancestor must not block it)', () => {
    expect(canOpenCursorChat(target('DIV', { inside: ['.react-flow__pane'] }))).toBe(true)
    // Each typing zone must be its OWN selector in the list: an element inside `.monaco-editor`
    // alone (never inside `.xterm`) still owns the keyboard.
    expect(canOpenCursorChat(target('DIV', { inside: ['.monaco-editor', '.react-flow'] }))).toBe(
      false
    )
  })
})

describe('counterScale', () => {
  it('cancels the viewport zoom so the cursor chrome keeps a constant on-screen size', () => {
    expect(counterScale(1)).toBe('scale(1)')
    expect(counterScale(0.5)).toBe('scale(2)')
    expect(counterScale(2)).toBe('scale(0.5)')
    expect(counterScale(0.2)).toBe('scale(5)')
  })

  it('rounds, so a jittery zoom does not produce a 17-digit transform string', () => {
    expect(counterScale(3)).toBe('scale(0.3333)')
  })

  it('falls back to 1× on a zoom React Flow can never actually report (0, negative, NaN)', () => {
    expect(counterScale(0)).toBe('scale(1)')
    expect(counterScale(-1)).toBe('scale(1)')
    expect(counterScale(Number.NaN)).toBe('scale(1)')
    expect(counterScale(Number.POSITIVE_INFINITY)).toBe('scale(1)')
  })
})
