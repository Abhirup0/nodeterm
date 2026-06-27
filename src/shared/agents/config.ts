// Single source of truth for agent launch behavior and capabilities.
// Design: an open AgentId string, a declarative config record, and
// capabilities expressed as const membership lists (not a capability object).

export type BuiltinAgentId = 'claude' | 'codex' | 'gemini'
// Open type — custom agents are any string ('custom:<uuid>'). Never restrict the set.
export type AgentId = BuiltinAgentId | (string & {})

export type PromptInjectionMode = 'argv' | 'flag-prompt' | 'stdin-after-start'

export interface AgentConfig {
  label: string // menu + node title, e.g. 'Claude Code'
  color: string // node color
  launchCmd: string // base launch command
  promptInjectionMode: PromptInjectionMode
  expectedProcess: string
}

export const BUILTIN_AGENT_IDS: readonly BuiltinAgentId[] = ['claude', 'codex', 'gemini']

export const AGENT_CONFIG: Record<BuiltinAgentId, AgentConfig> = {
  claude: {
    label: 'Claude Code',
    color: '#d97757',
    launchCmd: 'claude',
    promptInjectionMode: 'argv',
    expectedProcess: 'claude'
  },
  codex: {
    label: 'Codex',
    color: '#10a37f',
    launchCmd: 'codex',
    promptInjectionMode: 'argv',
    expectedProcess: 'codex'
  },
  gemini: {
    label: 'Gemini',
    color: '#4285f4',
    launchCmd: 'gemini',
    promptInjectionMode: 'stdin-after-start',
    expectedProcess: 'gemini'
  }
}

// Capabilities = const membership lists. A custom agent is in no list, so it
// automatically gets only spawn + terminal-title + process status.
export const AGENT_HOOK_TARGETS = ['claude', 'codex', 'gemini'] as const
export const RESUMABLE_AGENTS = ['claude', 'codex', 'gemini'] as const
export const SUBAGENT_CAPABLE = ['claude'] as const
export const RECURRING_CAPABLE = ['claude'] as const // /loop, /schedule, /cron
export const BRANCH_CAPABLE = ['claude'] as const
export const CONTEXT_LINK_CAPABLE = ['claude'] as const
export const USAGE_CAPABLE = ['claude'] as const
// Agents whose structured transcript we can render as a chat panel (Cmd+M chat mode).
export const CHAT_CAPABLE = ['claude'] as const
// Agents whose native transcript we can read + render for cross-agent transfer.
export const TRANSFER_SOURCE_CAPABLE = ['claude', 'codex', 'gemini'] as const

const includes = (list: readonly string[], id: AgentId): boolean => list.includes(id)

export const hasHooks = (id: AgentId): boolean => includes(AGENT_HOOK_TARGETS, id)
export const canResume = (id: AgentId): boolean => includes(RESUMABLE_AGENTS, id)
export const canSubagent = (id: AgentId): boolean => includes(SUBAGENT_CAPABLE, id)
export const canRecur = (id: AgentId): boolean => includes(RECURRING_CAPABLE, id)
export const canBranch = (id: AgentId): boolean => includes(BRANCH_CAPABLE, id)
export const canContextLink = (id: AgentId): boolean => includes(CONTEXT_LINK_CAPABLE, id)
export const hasUsage = (id: AgentId): boolean => includes(USAGE_CAPABLE, id)
export const canChat = (id: AgentId): boolean => includes(CHAT_CAPABLE, id)
export const canTransferFrom = (id: AgentId): boolean => includes(TRANSFER_SOURCE_CAPABLE, id)

// Returns the builtin config for an id, or undefined for custom/unknown agents.
export const agentConfig = (id: AgentId): AgentConfig | undefined =>
  (AGENT_CONFIG as Record<string, AgentConfig>)[id]
