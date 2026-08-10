import { describe, expect, it } from 'vitest'
import { readsClaudeTranscript } from './transcriptGates'
import { hasUsage, type AgentId } from '@shared/agents/config'

describe('readsClaudeTranscript', () => {
  it('is true for claude, whose transcript our readers own', () => {
    expect(readsClaudeTranscript('claude')).toBe(true)
  })

  it('is false for every agent whose transcript is NOT claude-shaped', () => {
    for (const id of ['codex', 'gemini', 'grok', 'opencode'] as AgentId[]) {
      expect(readsClaudeTranscript(id)).toBe(false)
    }
  })

  it('is false for a custom agent and for no agent at all (a plain terminal)', () => {
    expect(readsClaudeTranscript('my-custom-agent' as AgentId)).toBe(false)
    expect(readsClaudeTranscript(undefined)).toBe(false)
  })

  it('does NOT follow the context meter — the regression this gate exists for', () => {
    // The bug: `context.ensure` and the find bar's transcript index were gated on `hasUsage`, so
    // joining codex/gemini to USAGE_CAPABLE silently pointed both at claude's `resolveTranscript`.
    // Its cwd fallback returns the newest CLAUDE transcript for the node's cwd, so a codex node
    // metered — and searched — an unrelated claude session.
    //
    // These two expectations must therefore DISAGREE for codex and gemini. If this gate is ever
    // wired back to `hasUsage`, the second one fails.
    for (const id of ['codex', 'gemini'] as AgentId[]) {
      expect(hasUsage(id)).toBe(true) // it has a meter (fed by its OWN tail, no resolver involved)
      expect(readsClaudeTranscript(id)).toBe(false) // …and still no claude-transcript read
    }
    // claude is the one agent for which both are true, which is why the shared gate went unnoticed.
    expect(hasUsage('claude')).toBe(true)
    expect(readsClaudeTranscript('claude')).toBe(true)
  })
})
