import { describe, expect, it } from 'vitest'
import { formatModelLabel } from './usageFormat'

describe('formatModelLabel', () => {
  it('formats family + version ids', () => {
    expect(formatModelLabel('claude-opus-4-8')).toBe('Opus 4.8')
    expect(formatModelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(formatModelLabel('claude-fable-5')).toBe('Fable 5')
  })

  it('drops date suffixes', () => {
    expect(formatModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(formatModelLabel('claude-opus-4-1-20250805')).toBe('Opus 4.1')
  })

  it('handles legacy version-first ids', () => {
    expect(formatModelLabel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  })

  it('ignores non-numeric segments like a [1m] marker', () => {
    expect(formatModelLabel('claude-sonnet-4-5[1m]')).toBe('Sonnet 4.5')
  })

  it('returns a family with no version bare', () => {
    expect(formatModelLabel('sonnet')).toBe('Sonnet')
  })

  it('passes through unknown ids and keeps null', () => {
    expect(formatModelLabel('some-custom-model')).toBe('some-custom-model')
    expect(formatModelLabel(null)).toBeNull()
  })
})
