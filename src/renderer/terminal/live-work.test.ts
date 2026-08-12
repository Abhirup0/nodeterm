import { describe, it, expect } from 'vitest'
import { effectiveAgentState, wouldKillLiveWork } from './live-work'

describe('wouldKillLiveWork', () => {
  it('is true only for a NON-tmux session whose agent is working/waiting/blocked', () => {
    for (const agentState of ['working', 'waiting', 'blocked'] as const) {
      expect(wouldKillLiveWork({ tmuxBacked: false, agentState })).toBe(true)
    }
  })
  it('is false for a tmux-backed session, whatever its agent is doing', () => {
    // The kill only detaches our client there — tmux, the pane and the CLI all keep running.
    for (const agentState of ['working', 'waiting', 'blocked', 'done', undefined] as const) {
      expect(wouldKillLiveWork({ tmuxBacked: true, agentState })).toBe(false)
    }
  })
  it('is false for a finished or unknown agent, and for a terminal with no agent at all', () => {
    expect(wouldKillLiveWork({ tmuxBacked: false, agentState: 'done' })).toBe(false)
    expect(wouldKillLiveWork({ tmuxBacked: false })).toBe(false)
  })
})

describe('effectiveAgentState — the snapshot FLOOR under a live store read', () => {
  it('falls back to the snapshot when the store has forgotten the node', () => {
    // THE #126 REPRO. TerminalNode's departure effect clears agent status on the very unmount that
    // parks the terminal, so every later reader — the LRU in a microtask, the expiry minutes on —
    // sees `undefined` and calls a working agent disposable. The snapshot is what survives it.
    expect(effectiveAgentState(undefined, 'working')).toBe('working')
    expect(effectiveAgentState(undefined, 'waiting')).toBe('waiting')
  })
  it('lets a LIVE state override the snapshot in both directions', () => {
    // Hook events keep landing for a parked node (Canvas's listener is keyed by node id, not by
    // mount), so a turn that ends while parked must be able to RELEASE the protection…
    expect(effectiveAgentState('done', 'working')).toBe('done')
    // …and one that starts must be able to add it.
    expect(effectiveAgentState('working', 'done')).toBe('working')
  })
  it('is undefined only when neither knows anything', () => {
    expect(effectiveAgentState(undefined, undefined)).toBeUndefined()
  })
})
