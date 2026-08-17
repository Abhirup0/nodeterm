import { describe, it, expect, afterEach } from 'vitest'
import { accountNodeColor, createAgentNode } from './workspace'
import { useSettings } from './settings'
import { agentConfig } from '@shared/agents/config'
import { DEFAULT_SETTINGS, type ClaudeAccount } from '@shared/types'

const withAccounts = (claudeAccounts: ClaudeAccount[]): void => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudeAccounts } })
}

const account = (id: string, color?: string): ClaudeAccount => ({
  id,
  label: id,
  createdAt: 0,
  ...(color ? { color } : {})
})

const AGENT_COLOR = (id: string): string => agentConfig(id)!.color

afterEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

describe('accountNodeColor', () => {
  const accounts = [account('a1', '#0a84ff'), account('a2')]

  it('returns the account’s color', () => {
    expect(accountNodeColor('a1', accounts)).toBe('#0a84ff')
  })

  it('is undefined when the account has no color set', () => {
    expect(accountNodeColor('a2', accounts)).toBeUndefined()
  })

  it('is undefined for an id that no longer resolves — a removed account never colors a node', () => {
    expect(accountNodeColor('gone', accounts)).toBeUndefined()
  })

  it('is undefined when no account is bound', () => {
    expect(accountNodeColor(undefined, accounts)).toBeUndefined()
  })

  it('is undefined for a blank color — an empty string must not paint a node transparent', () => {
    expect(accountNodeColor('a3', [account('a3', '   ')])).toBeUndefined()
  })
})

describe('createAgentNode — account default color', () => {
  it('opens a Claude node in its account’s color instead of the agent’s', () => {
    withAccounts([account('a1', '#0a84ff')])
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.color).toBe('#0a84ff')
  })

  it('keeps the agent’s own color when the account sets none', () => {
    withAccounts([account('a1')])
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.color).toBe(AGENT_COLOR('claude'))
  })

  it('keeps the agent’s own color for an account id that no longer resolves', () => {
    withAccounts([account('a1', '#0a84ff')])
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, 'gone')
    expect(node.data.color).toBe(AGENT_COLOR('claude'))
  })

  it('never colors a non-Claude node — accounts are Claude-only, and so is their color', () => {
    withAccounts([account('a1', '#0a84ff')])
    const node = createAgentNode('codex', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.color).toBe(AGENT_COLOR('codex'))
  })

  it('leaves an account-less node exactly where it was before the feature', () => {
    withAccounts([account('a1', '#0a84ff')])
    expect(createAgentNode('claude', 0).data.color).toBe(AGENT_COLOR('claude'))
  })
})
