import { describe, it, expect } from 'vitest'
import { handoffFilename } from './index'

describe('handoffFilename', () => {
  it('builds a filesystem-safe handoff filename', () => {
    expect(handoffFilename('term_5', '2026-06-23T11-12-00-000Z')).toBe(
      'handoff-term_5-2026-06-23T11-12-00-000Z.md'
    )
  })
})
