import { describe, it, expect } from 'vitest'
import { wouldKillLiveWork } from './live-work'

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
