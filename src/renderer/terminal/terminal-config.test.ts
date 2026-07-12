import { describe, it, expect } from 'vitest'
import {
  xtermScrollback,
  XTERM_SCROLLBACK_MAX,
  isCopyShortcut,
  attachReplay,
  toXtermText,
  type CopyShortcutEvent
} from './terminal-config'

const ev = (p: Partial<CopyShortcutEvent>): CopyShortcutEvent => ({
  type: 'keydown',
  key: 'c',
  code: 'KeyC',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...p
})

describe('attachReplay', () => {
  it('replays the persisted snapshot on a cold start (tmux session gone)', () => {
    expect(attachReplay({ parked: false, fresh: true, hasInitialCommand: false })).toBe('cold-snapshot')
  })

  it('hydrates from tmux history on a warm reattach (fresh xterm, live session)', () => {
    expect(attachReplay({ parked: false, fresh: false, hasInitialCommand: false })).toBe('warm-history')
  })

  it('seeds nothing on a brand-new node (fresh session + launch command)', () => {
    expect(attachReplay({ parked: false, fresh: true, hasInitialCommand: true })).toBe('none')
  })

  it('seeds nothing for a parked terminal — its buffer is already correct', () => {
    // Both fresh values: an adopted xterm must never be seeded, or the content would double.
    expect(attachReplay({ parked: true, fresh: false, hasInitialCommand: false })).toBe('none')
    expect(attachReplay({ parked: true, fresh: true, hasInitialCommand: false })).toBe('none')
    expect(attachReplay({ parked: true, fresh: true, hasInitialCommand: true })).toBe('none')
  })
})

describe('toXtermText', () => {
  it('turns tmux capture-pane LFs into CRLFs (xterm runs with convertEol off)', () => {
    expect(toXtermText('one\ntwo\n')).toBe('one\r\ntwo\r\n')
  })

  it('leaves existing CRLFs alone', () => {
    expect(toXtermText('one\r\ntwo')).toBe('one\r\ntwo')
  })

  it('keeps escape sequences untouched', () => {
    expect(toXtermText('\x1b[31mred\x1b[0m\n')).toBe('\x1b[31mred\x1b[0m\r\n')
  })
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
    expect(isCopyShortcut(ev({ metaKey: true, key: 'v', code: 'KeyV' }))).toBe(false)
    expect(isCopyShortcut(ev({ metaKey: true, type: 'keyup' }))).toBe(false)
    expect(isCopyShortcut(ev({ metaKey: true, altKey: true }))).toBe(false)
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, metaKey: true }))).toBe(false)
  })

  it('accepts an uppercase key (Shift makes Ctrl+Shift+C report "C")', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'C' }))).toBe(true)
  })

  it('copies on a non-Latin layout, where e.key is not "c" (physical KeyC)', () => {
    // Cyrillic layout: the C key reports 'с' (U+0441), Greek reports 'ψ'.
    expect(isCopyShortcut(ev({ metaKey: true, key: 'с', code: 'KeyC' }))).toBe(true)
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'с', code: 'KeyC' }))).toBe(true)
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'ψ', code: 'KeyC' }))).toBe(true)
    // Plain Ctrl on the same layout still reaches the pty as SIGINT.
    expect(isCopyShortcut(ev({ ctrlKey: true, key: 'с', code: 'KeyC' }))).toBe(false)
  })

  it('does not copy when neither the printed nor the physical key is C', () => {
    expect(isCopyShortcut(ev({ metaKey: true, key: 'ц', code: 'KeyW' }))).toBe(false)
  })

  it('copies on Cmd+Shift+C too (no competing binding; asserted, not accidental)', () => {
    expect(isCopyShortcut(ev({ metaKey: true, shiftKey: true }))).toBe(true)
  })

  it('leaves AltGr combos alone (ctrl+alt+shift+C must not copy)', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false)
    expect(isCopyShortcut(ev({ ctrlKey: true, altKey: true }))).toBe(false)
  })
})
