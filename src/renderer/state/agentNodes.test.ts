import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentNodes } from './agentNodes'

describe('useAgentNodes.finish', () => {
  beforeEach(() => {
    useAgentNodes.setState({ byId: {}, activityById: {}, positions: {}, sizes: {}, expanded: {} })
  })

  it('keeps an explicit durationMs from the hook stats', () => {
    useAgentNodes.getState().start('tu1', { parentNodeId: 'n1' })
    useAgentNodes.getState().finish('tu1', { durationMs: 4200, tokens: 10 })
    expect(useAgentNodes.getState().byId['tu1']).toMatchObject({ state: 'done', durationMs: 4200, tokens: 10 })
  })

  // Async subagents end via a <task-notification> that carries no timing stats — the card
  // should still show a duration, computed from its own startedAt.
  it('falls back to elapsed-since-start when the end event has no durationMs', () => {
    useAgentNodes.getState().start('tu2', { parentNodeId: 'n1' })
    useAgentNodes.setState((s) => ({
      byId: { ...s.byId, tu2: { ...s.byId.tu2, startedAt: Date.now() - 5000 } }
    }))
    useAgentNodes.getState().finish('tu2', { result: 'done via notification' })
    const v = useAgentNodes.getState().byId['tu2']
    expect(v.state).toBe('done')
    expect(v.durationMs).toBeGreaterThanOrEqual(4500)
    expect(v.durationMs).toBeLessThan(20000)
  })
})
