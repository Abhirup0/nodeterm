import type { AgentId } from './config'

export type AgentState = 'working' | 'waiting' | 'blocked' | 'done'

// The universal event shape every agent normalizer produces. Agent-specific
// field names live only inside the per-agent normalizers below.
export interface NormalizedAgentEvent {
  nodeId: string
  agentId: AgentId
  kind: 'state' | 'subagent-start' | 'subagent-end' | 'recurring' | 'session'
  state?: AgentState
  // true only for a genuine new turn (Claude UserPromptSubmit), so the renderer can
  // clear per-turn fan-out without clearing on every mid-turn tool event.
  newTurn?: boolean
  sessionId?: string
  lastMessage?: string
  // session
  sessionTitle?: string
  // session lifecycle phase: 'start' resets to idle, 'end' resets + clears loop/fan-out
  sessionPhase?: 'start' | 'end'
  // subagent
  toolUseId?: string
  subagentType?: string
  taskLabel?: string
  durationMs?: number
  tokens?: number
  toolUses?: number
  result?: string
  // recurring
  recurringKind?: 'loop' | 'schedule' | 'cron'
  task?: string
  schedule?: string
}

// What the hook server hands a normalizer: the node id, the agent id, and the
// agent's raw hook JSON (parsed) plus the prompt text when present.
export interface RawHookEnvelope {
  nodeId: string
  agentId: AgentId
  payload: Record<string, unknown>
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
const RECURRING_TOOLS = new Set(['Skill', 'CronCreate', 'ScheduleWakeup'])

interface ClaudePayload {
  hook_event_name?: string
  session_id?: string
  notification_type?: string
  last_assistant_message?: string
  prompt?: string
  tool_name?: string
  tool_use_id?: string
  tool_input?: {
    subagent_type?: string
    description?: string
    prompt?: string
    skill?: string
    cron?: string
  }
  tool_response?: {
    status?: string
    content?: { type?: string; text?: string }[]
    totalDurationMs?: number
    totalTokens?: number
    totalToolUseCount?: number
  }
}

export function normalizeClaude(env: RawHookEnvelope): NormalizedAgentEvent | null {
  const p = env.payload as ClaudePayload
  const base = { nodeId: env.nodeId, agentId: env.agentId, sessionId: p.session_id }
  const ev = p.hook_event_name
  const tool = p.tool_name ?? ''

  if (ev === 'PreToolUse' || ev === 'PostToolUse') {
    if (SUBAGENT_TOOLS.has(tool)) {
      if (ev === 'PreToolUse') {
        return {
          ...base,
          kind: 'subagent-start',
          toolUseId: p.tool_use_id,
          subagentType: p.tool_input?.subagent_type,
          taskLabel: p.tool_input?.description ?? p.tool_input?.prompt
        }
      }
      return {
        ...base,
        kind: 'subagent-end',
        toolUseId: p.tool_use_id,
        durationMs: p.tool_response?.totalDurationMs,
        tokens: p.tool_response?.totalTokens,
        toolUses: p.tool_response?.totalToolUseCount,
        result: p.tool_response?.content
          ?.filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n')
      }
    }
    if (ev === 'PreToolUse' && RECURRING_TOOLS.has(tool)) {
      let recurringKind: NormalizedAgentEvent['recurringKind']
      if (tool === 'Skill') {
        const sk = (p.tool_input?.skill ?? '').split(':').pop()
        if (sk === 'loop' || sk === 'schedule' || sk === 'cron') recurringKind = sk
      } else if (tool === 'CronCreate') recurringKind = 'cron'
      else if (tool === 'ScheduleWakeup') recurringKind = 'loop'
      if (recurringKind) {
        return {
          ...base,
          kind: 'recurring',
          recurringKind,
          schedule: p.tool_input?.cron,
          task: p.tool_input?.prompt
        }
      }
    }
    // Any other tool use is just "working".
    return { ...base, kind: 'state', state: 'working' }
  }

  if (ev === 'UserPromptSubmit') {
    return { ...base, kind: 'state', state: 'working', task: p.prompt, newTurn: true }
  }
  if (ev === 'Stop') {
    return { ...base, kind: 'state', state: 'done', lastMessage: p.last_assistant_message }
  }
  if (ev === 'Notification') {
    const state: AgentState = p.notification_type === 'permission_prompt' ? 'blocked' : 'waiting'
    return { ...base, kind: 'state', state, lastMessage: p.last_assistant_message }
  }
  if (ev === 'SessionStart') return { ...base, kind: 'session', sessionPhase: 'start' }
  if (ev === 'SessionEnd') return { ...base, kind: 'session', sessionPhase: 'end' }
  return null
}

// Codex hook payload. Event name is read defensively; codex emits a session id under
// `session_id`.
interface CodexPayload {
  hook_event_name?: string
  hookEventName?: string
  session_id?: string
  prompt?: string
}

export function normalizeCodex(env: RawHookEnvelope): NormalizedAgentEvent | null {
  const p = env.payload as CodexPayload
  const ev = p.hook_event_name ?? p.hookEventName
  const base = { nodeId: env.nodeId, agentId: env.agentId, sessionId: p.session_id }

  // UserPromptSubmit is codex's turn start — flag newTurn so the renderer clears
  // per-turn fan-out once per turn, not on every tool event.
  if (ev === 'UserPromptSubmit') {
    return { ...base, kind: 'state', state: 'working', newTurn: true }
  }
  // SessionStart + tool events keep the node "working".
  if (ev === 'SessionStart' || ev === 'PreToolUse' || ev === 'PostToolUse') {
    return { ...base, kind: 'state', state: 'working' }
  }
  if (ev === 'PermissionRequest') return { ...base, kind: 'state', state: 'waiting' }
  if (ev === 'Stop') return { ...base, kind: 'state', state: 'done' }
  return null
}

// Gemini hook payload. Event name is read defensively (some builds use
// `hook_event_name`/`hookEventName`); a session id may be present under `session_id`.
interface GeminiPayload {
  hook_event_name?: string
  hookEventName?: string
  event?: string
  session_id?: string
}

export function normalizeGemini(env: RawHookEnvelope): NormalizedAgentEvent | null {
  const p = env.payload as GeminiPayload
  const ev = p.hook_event_name ?? p.hookEventName ?? p.event
  const base = { nodeId: env.nodeId, agentId: env.agentId, sessionId: p.session_id }

  // BeforeAgent is gemini's turn start — flag newTurn (mirrors Claude's UserPromptSubmit)
  // so per-turn fan-out clears once per turn rather than on every tool event.
  if (ev === 'BeforeAgent') {
    return { ...base, kind: 'state', state: 'working', newTurn: true }
  }
  if (ev === 'BeforeTool' || ev === 'AfterTool') {
    return { ...base, kind: 'state', state: 'working' }
  }
  if (ev === 'AfterAgent') return { ...base, kind: 'state', state: 'done' }
  // Gemini has no waiting/blocked states.
  return null
}

export function normalizeFor(agentId: AgentId, env: RawHookEnvelope): NormalizedAgentEvent | null {
  if (agentId === 'claude') return normalizeClaude(env)
  if (agentId === 'codex') return normalizeCodex(env)
  if (agentId === 'gemini') return normalizeGemini(env)
  return null
}
