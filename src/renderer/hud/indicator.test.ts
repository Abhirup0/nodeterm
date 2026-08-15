import { describe, it, expect } from 'vitest'
import { buildIndicator, orderIndicatorAgents, type IndicatorRow } from './indicator'

const row = (state: IndicatorRow['state'], agentId?: string): IndicatorRow => ({ state, agentId })

describe('buildIndicator', () => {
  it('lists distinct working agents in first-seen order and flags done-unseen', () => {
    const ind = buildIndicator([
      row('done', 'gemini'),
      row('working', 'claude'),
      row('working', 'codex'),
      row('working', 'claude')
    ])
    expect(ind.workingAgents).toEqual(['claude', 'codex'])
    expect(ind.doneUnseen).toBe(true)
    expect(ind.needsYou).toBe(false)
  })

  it('flags needsYou, so a waiting session is never an empty black pill', () => {
    // The rule this aggregation is the single definition of: a session waiting on the user with
    // nothing working must still put the red dot in the collapsed capsule.
    const ind = buildIndicator([row('needsYou', 'claude')])
    expect(ind.needsYou).toBe(true)
    expect(ind.workingAgents).toEqual([])
    expect(ind.doneUnseen).toBe(false)
  })

  it('buckets a working row with no agentId under "unknown"', () => {
    expect(buildIndicator([row('working')]).workingAgents).toEqual(['unknown'])
  })

  it('ignores idle rows and handles an empty list', () => {
    expect(buildIndicator([row('idle', 'claude')])).toEqual({
      workingAgents: [],
      doneUnseen: false,
      needsYou: false
    })
    expect(buildIndicator([])).toEqual({ workingAgents: [], doneUnseen: false, needsYou: false })
  })

  it('reports all three at once', () => {
    const ind = buildIndicator([row('working', 'codex'), row('done', 'claude'), row('needsYou', 'gemini')])
    expect(ind).toEqual({ workingAgents: ['codex'], doneUnseen: true, needsYou: true })
  })
})

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
