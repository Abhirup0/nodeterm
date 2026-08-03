import { describe, it, expect } from 'vitest'
import { resolveAppTheme, type AppThemePref } from './appTheme'

describe('resolveAppTheme', () => {
  it('follows the terminal theme on auto', () => {
    expect(resolveAppTheme('auto', true)).toBe('dark')
    expect(resolveAppTheme('auto', false)).toBe('light')
  })

  it('honours an explicit choice whatever the terminal theme is', () => {
    expect(resolveAppTheme('dark', false)).toBe('dark')
    expect(resolveAppTheme('light', true)).toBe('light')
  })

  // settings.json is hand-editable and travels between versions; dark is what every existing
  // install renders, so an unreadable value must land there rather than flipping the app white.
  it('falls back to dark for an unrecognised preference', () => {
    expect(resolveAppTheme('sepia' as AppThemePref, true)).toBe('dark')
    expect(resolveAppTheme(undefined as unknown as AppThemePref, false)).toBe('dark')
  })
})
