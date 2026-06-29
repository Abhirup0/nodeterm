import { describe, expect, it } from 'vitest'
import { parseLatestUsage } from './context-tail'

describe('parseLatestUsage', () => {
  it('returns the LAST assistant usage in the text (sum of input + cache tokens)', () => {
    const text = [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-x', usage: { input_tokens: 10, cache_read_input_tokens: 5 } } }),
      JSON.stringify({ type: 'user', message: {} }),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-y', usage: { input_tokens: 100, cache_creation_input_tokens: 20 } } })
    ].join('\n')
    expect(parseLatestUsage(text)).toEqual({ used: 120, model: 'claude-y' })
  })
  it('ignores non-assistant lines, zero-usage, and garbled JSON; null when none', () => {
    expect(parseLatestUsage('not json\n{"type":"assistant","message":{"usage":{"input_tokens":0}}}')).toBeNull()
    expect(parseLatestUsage('')).toBeNull()
  })
})
