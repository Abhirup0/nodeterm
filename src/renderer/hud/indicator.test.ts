import { describe, it, expect } from 'vitest'
import { orderIndicatorAgents } from './indicator'

describe('orderIndicatorAgents', () => {
  it('puts Claude rightmost (last) and Codex to its left, matching agent-notch', () => {
    // Rightmost = last child (notch-side). agent-notch draws claude nearest the notch, codex left.
    expect(orderIndicatorAgents(['claude', 'codex'])).toEqual(['codex', 'claude'])
    expect(orderIndicatorAgents(['codex', 'claude'])).toEqual(['codex', 'claude'])
  })

  it('orders gemini left of codex left of claude', () => {
    expect(orderIndicatorAgents(['claude', 'gemini', 'codex'])).toEqual(['gemini', 'codex', 'claude'])
  })

  it('keeps unknown/custom agents furthest left, in stable input order', () => {
    expect(orderIndicatorAgents(['claude', 'my-agent', 'other'])).toEqual(['my-agent', 'other', 'claude'])
  })

  it('handles a single agent and empty input', () => {
    expect(orderIndicatorAgents(['claude'])).toEqual(['claude'])
    expect(orderIndicatorAgents([])).toEqual([])
  })

  it('does not mutate the input array', () => {
    const input = ['claude', 'codex']
    orderIndicatorAgents(input)
    expect(input).toEqual(['claude', 'codex'])
  })
})
