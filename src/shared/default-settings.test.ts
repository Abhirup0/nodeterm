import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './types'

describe('DEFAULT_SETTINGS', () => {
  it('enables git auto-fetch by default', () => {
    expect(DEFAULT_SETTINGS.gitAutoFetch).toBe(true)
  })
})
