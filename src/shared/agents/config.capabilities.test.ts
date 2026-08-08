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

/**
 * Grok arrives with spawn + resume and nothing else, which is the registry's own design for a new
 * agent ("a custom agent is in no list, so it automatically gets only spawn + terminal-title +
 * process status"). Hooks, context links and canvas control each need per-agent machinery that has
 * not been written for it — an installer, a transcript parser, a discovery file — and claiming any
 * of them here would light badges that never update and offer menu items that do nothing.
 */
describe('grok capabilities', () => {
  it('is a builtin with a launch command and a colour', () => {
    expect(BUILTIN_AGENT_IDS).toContain('grok')
    expect(AGENT_CONFIG.grok.launchCmd).toBe('grok')
    expect(AGENT_CONFIG.grok.label).toBe('Grok')
  })

  it('takes its prompt as a positional, BEHIND a `--` separator', () => {
    // Measured against the shipped 1.0.0 binary, whose usage is `grok [OPTIONS] [PROMPT] [COMMAND]`
    // — the prompt shares its slot with the subcommand list. `grok version` prints the version and
    // exits; `grok -- version` opens a session with "version" as the prompt. Without the separator
    // a prompt of `help`, `version`, `login`, `models` or `export` is executed as a command and
    // never reaches the model.
    expect(AGENT_CONFIG.grok.promptInjectionMode).toBe('argv')
    expect(AGENT_CONFIG.grok.argvPromptSeparator).toBe('--')
  })

  it('is the ONLY agent that asks for a separator', () => {
    // claude takes a positional too, but has no subcommand a one-word prompt could shadow — and
    // adding `--` there would change a command line that works today.
    for (const id of BUILTIN_AGENT_IDS.filter((a) => a !== 'grok')) {
      expect(AGENT_CONFIG[id].argvPromptSeparator, id).toBeUndefined()
    }
  })

  it('claims resume and nothing beyond it', () => {
    expect(canResume('grok')).toBe(true)
    expect(hasHooks('grok')).toBe(false)
    expect(canContextLink('grok')).toBe(false)
    expect(canBranch('grok')).toBe(false)
    expect(canControlCanvas('grok')).toBe(false)
  })
})
