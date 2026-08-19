import { describe, it, expect, beforeEach } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { CommandId } from '@shared/keybindings'
import { useSettings } from '../state/settings'
import { shortcutCaptureCopy } from './shortcutCaptureCopy'

const setKb = (kb: unknown) =>
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keybindings: kb as never } })

beforeEach(() => setKb(undefined))

describe('shortcutCaptureCopy', () => {
  it('names the command and the chord that took the key', () => {
    const copy = shortcutCaptureCopy('app.commandPalette', true)
    expect(copy?.title).toBe('Command palette')
    expect(copy?.body).toContain('⌘K')
    expect(copy?.body).toContain('Command palette')
    // The two ways out are what the banner is FOR — a notice that only reports is noise.
    expect(copy?.body.toLowerCase()).toContain('terminal-first')
  })

  it('spells the chord the way the platform does', () => {
    expect(shortcutCaptureCopy('app.commandPalette', false)?.body).toContain('Ctrl+K')
  })

  it('follows a remap, so the notice quotes the chord the user actually pressed', () => {
    setKb({ 'app.commandPalette': ['Cmd+Shift+P'] })
    expect(shortcutCaptureCopy('app.commandPalette', true)?.body).toContain('⌘⇧P')
  })

  // Both halves of "say nothing": there is no chord to quote, so a banner could only claim a
  // key was taken without naming one.
  it('is null for an unbound command', () => {
    expect(shortcutCaptureCopy('canvas.fitAll', true)).toBeNull()
  })

  it('is null for a DISABLED command', () => {
    setKb({ 'app.commandPalette': [] })
    expect(shortcutCaptureCopy('app.commandPalette', true)).toBeNull()
  })

  // The event's detail crosses a `window` boundary, so the id is not a compile-time fact.
  it('is null for an id the registry does not know', () => {
    expect(shortcutCaptureCopy('bogus.command' as CommandId, true)).toBeNull()
  })
})
