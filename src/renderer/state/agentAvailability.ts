import type { Settings } from '@shared/types'
import { BUILTIN_AGENT_IDS, type AgentId } from '@shared/agents/config'

type Avail = Pick<Settings, 'disabledAgents' | 'defaultAgent'>

export function isAgentEnabled(settings: Pick<Settings, 'disabledAgents'>, id: AgentId): boolean {
  return !settings.disabledAgents.includes(id)
}

// First non-disabled builtin in claude → codex → gemini order; 'claude' if all disabled.
export function firstEnabledBuiltin(disabled: AgentId[]): AgentId {
  return BUILTIN_AGENT_IDS.find((id) => !disabled.includes(id)) ?? 'claude'
}

// Enable/disable an agent; if the current default gets disabled, reassign it.
export function setAgentEnabled(settings: Avail, id: AgentId, enabled: boolean): Avail {
  const disabled = enabled
    ? settings.disabledAgents.filter((a) => a !== id)
    : settings.disabledAgents.includes(id)
      ? settings.disabledAgents
      : [...settings.disabledAgents, id]
  const defaultAgent =
    !enabled && settings.defaultAgent === id ? firstEnabledBuiltin(disabled) : settings.defaultAgent
  return { disabledAgents: disabled, defaultAgent }
}

// Make an agent the default; re-enable it if it was disabled.
export function setDefaultAgent(settings: Avail, id: AgentId): Avail {
  return { disabledAgents: settings.disabledAgents.filter((a) => a !== id), defaultAgent: id }
}
