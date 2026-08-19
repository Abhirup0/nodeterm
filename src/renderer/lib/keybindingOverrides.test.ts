import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from '../state/settings'
import {
  activeKeybindingOverrides, effectiveBindings, commandKeys, commandTooltip, chipFor
} from './keybindingOverrides'

const setKb = (kb: unknown) =>
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keybindings: kb as never } })

beforeEach(() => setKb(undefined))

describe('activeKeybindingOverrides', () => {
  it('absent key means no overrides, silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(activeKeybindingOverrides()).toEqual({})
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
  it('sanitizes and memoizes by reference, warning once per change', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setKb({ 'node.newTerminal': ['Cmd+Shift+T'], 'bogus.command': ['Cmd+X'] })
    const first = activeKeybindingOverrides()
    expect(first).toEqual({ 'node.newTerminal': ['Cmd+Shift+T'] })
    expect(activeKeybindingOverrides()).toBe(first)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('effectiveBindings / commandKeys / commandTooltip', () => {
  it('defaults flow through when no override exists', () => {
    expect(effectiveBindings('app.commandPalette')).toEqual(['Cmd+K'])
  })
  it('an override replaces the default everywhere', () => {
    setKb({ 'panel.sessions': ['Cmd+Alt+L'] })
    expect(commandKeys('panel.sessions', true)).toEqual(['⌘', '⌥', 'L'])
    expect(commandTooltip('Sessions', 'panel.sessions', true)).toBe('Sessions (⌘⌥L)')
  })
  it('matches the legacy hintLabel formatting on both platforms for the defaults', () => {
    expect(commandTooltip('Sessions', 'panel.sessions', true)).toBe('Sessions (⌘⇧L)')
    expect(commandTooltip('Sessions', 'panel.sessions', false)).toBe('Sessions (Ctrl+Shift+L)')
  })
  it('resolves the defaults with the SAME platform it formats with', () => {
    // terminal.copySelection is the one command whose defaults differ per platform, so it is
    // the only case that can catch a commandKeys that resolves with isMacPlatform() (true in
    // node) while formatting for the caller's platform.
    expect(commandKeys('terminal.copySelection', true)).toEqual(['⌘', 'C'])
    expect(commandKeys('terminal.copySelection', false)).toEqual(['Ctrl', 'Shift', 'C'])
  })
  it('unbound commands render without a chord suffix', () => {
    expect(commandTooltip('Fit all', 'canvas.fitAll', true)).toBe('Fit all')
    expect(commandKeys('canvas.fitAll', true)).toEqual([])
  })
})

describe('chipFor', () => {
  it('renders the bare chord the way each platform spells it', () => {
    expect(chipFor('app.commandPalette', true)).toBe('⌘K')
    expect(chipFor('app.commandPalette', false)).toBe('Ctrl+K')
  })
  it('follows a remap', () => {
    setKb({ 'app.commandPalette': ['Cmd+Shift+P'] })
    expect(chipFor('app.commandPalette', true)).toBe('⌘⇧P')
  })
  it('is empty for an unbound command, so callers can fall back', () => {
    expect(chipFor('canvas.fitAll', true)).toBe('')
  })
})
