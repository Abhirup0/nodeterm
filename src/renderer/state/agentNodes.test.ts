import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentNodes } from './agentNodes'

describe('loop node overrides vs per-turn fan-out', () => {
  beforeEach(() => {
    useAgentNodes.setState({ byId: {}, activityById: {}, positions: {}, sizes: {}, expanded: {} })
  })

  // A loop/cron card outlives turns: a new prompt clears the subagent fan-out but must NOT
  // reset where the user dragged the loop card.
  it('clearForParent drops subagent overrides but keeps the loop card position', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.setPosition('tu1', { x: 1, y: 2 })
    s.setPosition('loop-n1', { x: 5, y: 6 })
    s.clearForParent('n1')
    expect(useAgentNodes.getState().positions['tu1']).toBeUndefined()
    expect(useAgentNodes.getState().positions['loop-n1']).toEqual({ x: 5, y: 6 })
  })

  it('clearLoop drops only the loop card overrides', () => {
    const s = useAgentNodes.getState()
    s.start('tu1', { parentNodeId: 'n1' })
    s.setPosition('tu1', { x: 1, y: 2 })
    s.setPosition('loop-n1', { x: 5, y: 6 })
    s.setSize('loop-n1', { width: 300, height: 200 })
    s.clearLoop('n1')
    const st = useAgentNodes.getState()
    expect(st.positions['loop-n1']).toBeUndefined()
    expect(st.sizes['loop-n1']).toBeUndefined()
    expect(st.positions['tu1']).toEqual({ x: 1, y: 2 })
    expect(st.byId['tu1']).toBeDefined()
  })
})

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

describe('loop card override persistence', () => {
  // Cron/schedule cards survive restarts (agentStatus.loop is persisted) — where the user
  // dragged the card must survive with them, or every launch teleports it back to the
  // default spot. Only loop-* overrides persist; subagent cards are per-turn anyway.
  it('persists loop-* position/size and drops them via clearLoop', async () => {
    const mem = new Map<string, string>()
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k)
    }
    const { vi } = await import('vitest')
    vi.stubGlobal('localStorage', store)
    vi.resetModules()
    const { useAgentNodes: fresh } = await import('./agentNodes')
    fresh.getState().setPosition('loop-n1', { x: 42, y: 43 })
    fresh.getState().setSize('loop-n1', { width: 300, height: 120 })
    fresh.getState().setPosition('tu-sub', { x: 1, y: 2 }) // subagent — must NOT persist
    const saved = JSON.parse(mem.get('nodeterm.loopCards')!)
    expect(saved.positions['loop-n1']).toEqual({ x: 42, y: 43 })
    expect(saved.sizes['loop-n1']).toEqual({ width: 300, height: 120 })
    expect(saved.positions['tu-sub']).toBeUndefined()
    fresh.getState().clearLoop('n1')
    const after = JSON.parse(mem.get('nodeterm.loopCards') ?? '{}')
    expect(after.positions?.['loop-n1']).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('hydrates persisted loop-* overrides on load', async () => {
    const mem = new Map<string, string>([
      [
        'nodeterm.loopCards',
        JSON.stringify({ positions: { 'loop-n2': { x: 9, y: 8 } }, sizes: {}, expanded: { 'loop-n2': true } })
      ]
    ])
    const store = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k)
    }
    const { vi } = await import('vitest')
    vi.stubGlobal('localStorage', store)
    vi.resetModules()
    const { useAgentNodes: fresh } = await import('./agentNodes')
    expect(fresh.getState().positions['loop-n2']).toEqual({ x: 9, y: 8 })
    expect(fresh.getState().expanded['loop-n2']).toBe(true)
    vi.unstubAllGlobals()
  })
})
