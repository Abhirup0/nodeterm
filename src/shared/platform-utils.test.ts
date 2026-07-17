import { describe, it, expect } from 'vitest'
import { hintLabel, keyLabel, modSymbol } from './platform-utils'

describe('hintLabel', () => {
  it('passes mac strings through untouched', () => {
    expect(hintLabel('Save (⌘S)', true)).toBe('Save (⌘S)')
    expect(hintLabel('Redo (⌘⇧Z)', true)).toBe('Redo (⌘⇧Z)')
  })
  it('rewrites plain chords on non-mac', () => {
    expect(hintLabel('Save (⌘S)', false)).toBe('Save (Ctrl+S)')
    expect(hintLabel('⌘K', false)).toBe('Ctrl+K')
    expect(hintLabel('Settings (⌘,)', false)).toBe('Settings (Ctrl+,)')
    expect(hintLabel('⌘/', false)).toBe('Ctrl+/')
  })
  it('rewrites shift chords on non-mac', () => {
    expect(hintLabel('Redo (⌘⇧Z)', false)).toBe('Redo (Ctrl+Shift+Z)')
    expect(hintLabel('Explorer (⌘⇧E)', false)).toBe('Explorer (Ctrl+Shift+E)')
  })
  it('keeps the return symbol and rewrites the modifier', () => {
    expect(hintLabel('Message (⌘↵ to commit)', false)).toBe('Message (Ctrl+↵ to commit)')
  })
  it('handles a bare ⌘ with no trailing key', () => {
    expect(hintLabel('no ⌘', false)).toBe('no Ctrl')
    expect(hintLabel('Zoom with a plain mouse wheel (no ⌘).', false)).toBe(
      'Zoom with a plain mouse wheel (no Ctrl).'
    )
  })
})

describe('keyLabel / modSymbol', () => {
  it('maps single key tokens', () => {
    expect(keyLabel('⌘', false)).toBe('Ctrl')
    expect(keyLabel('⇧', false)).toBe('Shift')
    expect(keyLabel('K', false)).toBe('K')
    expect(keyLabel('⌘', true)).toBe('⌘')
  })
  it('modSymbol matches keyLabel for ⌘', () => {
    expect(modSymbol(false)).toBe('Ctrl')
    expect(modSymbol(true)).toBe('⌘')
  })
})
