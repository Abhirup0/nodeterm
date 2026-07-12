import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './types'

describe('DEFAULT_SETTINGS', () => {
  it('enables git auto-fetch by default', () => {
    expect(DEFAULT_SETTINGS.gitAutoFetch).toBe(true)
  })

  it('defaults to auto permission mode for new and existing users', () => {
    // Deliberate behavior change: auto mode ensures Claude sessions start with
    // permission auto-grants enabled. This reaches existing users via
    // { ...DEFAULT_SETTINGS, ...saved } hydration. Do not change without a decision.
    expect(DEFAULT_SETTINGS.claudePermissionMode).toBe('auto')
  })
})
