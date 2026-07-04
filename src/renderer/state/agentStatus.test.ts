import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  useAgentStatus,
  inferInterruptAfterSettle,
  DONE_HOLDOFF_MS,
  STALE_WORKING_MS
} from './agentStatus'

let seq = 0
const nid = (): string => `node-${++seq}`

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('done-holdoff race guard', () => {
  // Claude Code runs hooks in parallel: the last PostToolUse's curl can land AFTER the
  // Stop's curl. Without a holdoff that late "working" resurrects a finished turn.
  it('ignores a non-newTurn working arriving right after done', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'working', 'claude')
    s.setState(id, 'done', 'claude')
    vi.advanceTimersByTime(1000)
    useAgentStatus.getState().setState(id, 'working', 'claude')
    expect(useAgentStatus.getState().byId[id].state).toBe('done')
  })

  it('a genuine new turn (newTurn) overrides the holdoff', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'done', 'claude')
    vi.advanceTimersByTime(1000)
    useAgentStatus.getState().setState(id, 'working', 'claude', true)
    expect(useAgentStatus.getState().byId[id].state).toBe('working')
  })

  it('working is accepted again once the holdoff has passed', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'done', 'claude')
    vi.advanceTimersByTime(DONE_HOLDOFF_MS + 500)
    useAgentStatus.getState().setState(id, 'working', 'claude')
    expect(useAgentStatus.getState().byId[id].state).toBe('working')
  })
})

describe('stale-working sweeper', () => {
  it('clears a working entry whose last event is older than the stale threshold', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'working', 'claude')
    vi.advanceTimersByTime(STALE_WORKING_MS + 60_000)
    useAgentStatus.getState().sweepStaleWorking()
    expect(useAgentStatus.getState().byId[id].state).toBeUndefined()
  })

  it('keeps a working entry fresh as long as events keep arriving', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'working', 'claude')
    // Repeated same-state events (each tool use) must refresh freshness.
    vi.advanceTimersByTime(STALE_WORKING_MS - 60_000)
    useAgentStatus.getState().setState(id, 'working', 'claude')
    vi.advanceTimersByTime(120_000)
    useAgentStatus.getState().sweepStaleWorking()
    expect(useAgentStatus.getState().byId[id].state).toBe('working')
  })

  it('never touches done/waiting entries', () => {
    const a = nid()
    const b = nid()
    useAgentStatus.getState().setState(a, 'done', 'claude')
    useAgentStatus.getState().setState(b, 'waiting', 'claude')
    vi.advanceTimersByTime(STALE_WORKING_MS * 2)
    useAgentStatus.getState().sweepStaleWorking()
    expect(useAgentStatus.getState().byId[a].state).toBe('done')
    expect(useAgentStatus.getState().byId[b].state).toBe('waiting')
  })
})

describe('interrupt inference (Esc/Ctrl-C with no final hook)', () => {
  it('flips a still-working node to done after the settle window', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'working', 'claude')
    inferInterruptAfterSettle(id, 1500)
    vi.advanceTimersByTime(1500)
    expect(useAgentStatus.getState().byId[id].state).toBe('done')
  })

  it('aborts when any hook event lands during the settle window (agent still alive)', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'working', 'claude')
    inferInterruptAfterSettle(id, 1500)
    vi.advanceTimersByTime(700)
    useAgentStatus.getState().setState(id, 'working', 'claude') // e.g. next PreToolUse
    vi.advanceTimersByTime(800)
    expect(useAgentStatus.getState().byId[id].state).toBe('working')
  })

  it('is a no-op when the node is not working (Esc at an idle prompt)', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'done', 'claude')
    inferInterruptAfterSettle(id, 1500)
    vi.advanceTimersByTime(1500)
    expect(useAgentStatus.getState().byId[id].state).toBe('done')
  })
})
