import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import {
  XTERM_INPUT_CLASS,
  isTerminalTarget,
  isTypingTarget,
  keyDispatchContextFor
} from './keyContext'

const el = (
  tagName: string,
  extra: Partial<{ isContentEditable: boolean; classes: string[] }> = {}
) => ({
  tagName,
  isContentEditable: extra.isContentEditable,
  classList: { contains: (n: string) => (extra.classes ?? []).includes(n) }
})

describe('isTerminalTarget', () => {
  it('true only for the xterm helper textarea', () => {
    expect(isTerminalTarget(el('TEXTAREA', { classes: [XTERM_INPUT_CLASS] }))).toBe(true)
    expect(isTerminalTarget(el('TEXTAREA'))).toBe(false)
    expect(isTerminalTarget(null)).toBe(false)
  })
})

describe('isTypingTarget', () => {
  it('inputs, textareas and contentEditable are typing', () => {
    expect(isTypingTarget(el('INPUT'))).toBe(true)
    expect(isTypingTarget(el('TEXTAREA'))).toBe(true)
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true)
  })
  it('the xterm helper textarea is NOT typing (it is the terminal)', () => {
    expect(isTypingTarget(el('TEXTAREA', { classes: [XTERM_INPUT_CLASS] }))).toBe(false)
  })
  it('plain elements and null are not typing', () => {
    expect(isTypingTarget(el('DIV'))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('keyDispatchContextFor', () => {
  it('typing and terminal are disjoint by construction', () => {
    expect(
      keyDispatchContextFor(el('TEXTAREA', { classes: [XTERM_INPUT_CLASS] }), false, false)
    ).toEqual({
      typing: false,
      terminal: true,
      kanbanOpen: false,
      terminalFirst: false
    })
    expect(keyDispatchContextFor(el('INPUT'), true, false)).toEqual({
      typing: true,
      terminal: false,
      kanbanOpen: true,
      terminalFirst: false
    })
  })
  it('carries the terminal-first policy through as given', () => {
    expect(
      keyDispatchContextFor(el('TEXTAREA', { classes: [XTERM_INPUT_CLASS] }), false, true)
    ).toEqual({
      typing: false,
      terminal: true,
      kanbanOpen: false,
      terminalFirst: true
    })
  })
})

describe('xterm version pin', () => {
  it('the installed xterm dist still renders the helper-textarea class', () => {
    // The entire terminal-vs-typing split keys off this class name. If an xterm upgrade
    // renames it, this test fails instead of every terminal keystroke silently becoming 'app'.
    const dist = readFileSync('node_modules/@xterm/xterm/lib/xterm.js', 'utf8')
    expect(dist.includes(XTERM_INPUT_CLASS)).toBe(true)
  })
})
