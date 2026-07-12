import { describe, it, expect } from 'vitest'
import { xtermScrollback, XTERM_SCROLLBACK_MAX, isCopyShortcut, type CopyShortcutEvent } from './terminal-config'

const ev = (p: Partial<CopyShortcutEvent>): CopyShortcutEvent => ({
  type: 'keydown',
  key: 'c',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...p
})

describe('xtermScrollback', () => {
  it('follows the tmux scrollback setting below the cap', () => {
    expect(xtermScrollback(2000)).toBe(2000)
  })

  it('caps the default 50000-line tmux scrollback', () => {
    expect(xtermScrollback(50000)).toBe(XTERM_SCROLLBACK_MAX)
    expect(XTERM_SCROLLBACK_MAX).toBe(10000)
  })
})

describe('isCopyShortcut', () => {
  it('copies on Cmd+C', () => {
    expect(isCopyShortcut(ev({ metaKey: true }))).toBe(true)
  })

  it('copies on Ctrl+Shift+C', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true }))).toBe(true)
  })

  it('leaves plain Ctrl+C alone so it still sends SIGINT', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true }))).toBe(false)
  })

  it('ignores other keys, keyups and extra modifiers', () => {
    expect(isCopyShortcut(ev({ metaKey: true, key: 'v' }))).toBe(false)
    expect(isCopyShortcut(ev({ metaKey: true, type: 'keyup' }))).toBe(false)
    expect(isCopyShortcut(ev({ metaKey: true, altKey: true }))).toBe(false)
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, metaKey: true }))).toBe(false)
  })

  it('accepts an uppercase key (Shift makes Ctrl+Shift+C report "C")', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'C' }))).toBe(true)
  })
})
