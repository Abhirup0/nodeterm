import { describe, it, expect } from 'vitest'
import {
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  canBranch,
  canChat,
  canContextLink,
  canControlCanvas,
  canRecur,
  canRename,
  canResume,
  canSubagent,
  canTransferFrom,
  createdAgentId,
  hasHooks,
  hasPermissionMode,
  hasUsage
} from './config'

describe('CONTEXT_LINK_CAPABLE', () => {
  it('all three builtin agents can context-link', () => {
    expect(canContextLink('claude')).toBe(true)
    expect(canContextLink('codex')).toBe(true)
    expect(canContextLink('gemini')).toBe(true)
  })
  it('custom agents cannot', () => {
    expect(canContextLink('custom:abc')).toBe(false)
  })
})

describe('opencode capabilities', () => {
  it('is a builtin with the parity capability set', () => {
    expect(BUILTIN_AGENT_IDS).toContain('opencode')
    expect(AGENT_CONFIG.opencode).toEqual({
      label: 'opencode',
      color: '#a78bfa',
      launchCmd: 'opencode',
      promptInjectionMode: 'flag-prompt',
      expectedProcess: 'opencode'
    })
    expect(hasHooks('opencode')).toBe(true)
    expect(canResume('opencode')).toBe(true)
    expect(canContextLink('opencode')).toBe(true)
    expect(canControlCanvas('opencode')).toBe(true)
  })
  it('stays out of the claude-only capability lists', () => {
    for (const can of [canSubagent, canRecur, canBranch, hasUsage, canChat, canTransferFrom, canRename, hasPermissionMode]) {
      expect(can('opencode')).toBe(false)
    }
  })
})

describe('createdAgentId', () => {
  it('reads data.agentId, with the legacy tags fallback', () => {
    expect(createdAgentId({ agentId: 'codex' })).toBe('codex')
    expect(createdAgentId({ tags: ['claude', 'x'] })).toBe('claude')
    expect(createdAgentId({ agentId: 'gemini', tags: ['claude'] })).toBe('gemini')
  })

  it('is undefined for a plain terminal, a foreign tag, or nothing at all', () => {
    expect(createdAgentId({})).toBeUndefined()
    expect(createdAgentId({ tags: ['review'] })).toBeUndefined()
    expect(createdAgentId(undefined)).toBeUndefined()
  })

  it('tolerates hand-edited project.json shapes', () => {
    // node data is deserialized JSON: nothing guarantees these types at runtime.
    expect(createdAgentId({ agentId: 42 })).toBeUndefined()
    expect(createdAgentId({ tags: 'claude' })).toBeUndefined()
  })
})
