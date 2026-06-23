import { describe, it, expect } from 'vitest'
import { handoffFilename } from './index'

describe('handoffFilename', () => {
  it('builds a filesystem-safe handoff filename', () => {
    expect(handoffFilename('term_5', '2026-06-23T11-12-00-000Z')).toBe(
      'handoff-term_5-2026-06-23T11-12-00-000Z.md'
    )
  })

  it('sanitizes path separators in the node id', () => {
    expect(handoffFilename('../../etc/x', '2026-01-01T00-00-00-000Z')).toBe(
      'handoff-______etc_x-2026-01-01T00-00-00-000Z.md'
    )
  })
})
