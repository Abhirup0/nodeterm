import { describe, expect, it } from 'vitest'
import { grokRawFields, normalizeClaude, normalizeGrok } from './normalize'

/**
 * Grok's hook envelope is its own dialect: camelCase keys whose `hookEventName` VALUE is
 * snake_case ("pre_tool_use"), and the grok SDK path converts the top-level keys to snake_case.
 * Both spellings are therefore read, and the event name is canonicalized rather than matched
 * literally — measured against the shipped 1.0.0 docs, not inferred from claude's shape.
 */
const env = (payload: Record<string, unknown>) => ({ nodeId: 'n1', agentId: 'grok', payload })

describe('normalizeGrok — lifecycle', () => {
  it('maps session_start / session_end to the session phases', () => {
    expect(normalizeGrok(env({ hookEventName: 'session_start', sessionId: 's1' }))).toEqual({
      nodeId: 'n1',
      agentId: 'grok',
      sessionId: 's1',
      kind: 'session',
      sessionPhase: 'start'
    })
    expect(normalizeGrok(env({ hookEventName: 'session_end', sessionId: 's1' }))?.sessionPhase).toBe('end')
  })

  it('treats user_prompt_submit as the turn start (newTurn)', () => {
    const e = normalizeGrok(env({ hookEventName: 'user_prompt_submit', sessionId: 's1', prompt: 'ship it' }))
    expect(e).toMatchObject({ kind: 'state', state: 'working', newTurn: true, task: 'ship it' })
  })

  it('keeps the node working across every tool event, including a tool FAILURE', () => {
    for (const ev of ['pre_tool_use', 'post_tool_use', 'post_tool_use_failure']) {
      expect(normalizeGrok(env({ hookEventName: ev, sessionId: 's1' }))).toMatchObject({
        kind: 'state',
        state: 'working'
      })
    }
  })
})

describe('normalizeGrok — Stop', () => {
  it('a genuine turn end is done, carrying the last assistant message', () => {
    const e = normalizeGrok(
      env({ hookEventName: 'stop', sessionId: 's1', reason: 'end_turn', lastAssistantMessage: 'done' })
    )
    expect(e).toMatchObject({ state: 'done', lastMessage: 'done' })
    // Not interrupted — a genuine turn end DOES earn the completion alert. Asserted separately
    // (as normalize.test.ts does for claude's Stop) because toMatchObject demands the key exist.
    expect(e?.interrupted).toBeFalsy()
  })

  it('an ABSENT reason is still a real turn end (never swallow the badge event)', () => {
    expect(normalizeGrok(env({ hookEventName: 'stop', sessionId: 's1' }))).toMatchObject({ state: 'done' })
  })

  it('the observe-only session-close Stop is marked interrupted, so no completion alert fires', () => {
    for (const reason of ['channel_closed', 'shutdown']) {
      const e = normalizeGrok(env({ hookEventName: 'stop', sessionId: 's1', reason, lastAssistantMessage: 'x' }))
      expect(e).toMatchObject({ state: 'done', interrupted: true })
      expect(e?.lastMessage).toBeUndefined()
    }
  })

  it('stop_failure ends the turn so the badge cannot stick on working', () => {
    expect(
      normalizeGrok(env({ hookEventName: 'stop_failure', sessionId: 's1', lastAssistantMessage: 'rate limited' }))
    ).toMatchObject({ state: 'done', lastMessage: 'rate limited' })
  })
})

describe('normalizeGrok — Notification', () => {
  it('a permission notification is blocked; an input request is waiting', () => {
    expect(
      normalizeGrok(env({ hookEventName: 'notification', notificationType: 'permission_prompt' }))
    ).toMatchObject({ state: 'blocked' })
    expect(
      normalizeGrok(env({ hookEventName: 'notification', notificationType: 'agent_needs_input' }))
    ).toMatchObject({ state: 'waiting' })
  })

  it('an idle notification is the rescue signal (done + idle), not a NEEDS YOU', () => {
    expect(normalizeGrok(env({ hookEventName: 'notification', notificationType: 'idle_prompt' }))).toMatchObject({
      state: 'done',
      idle: true,
      interrupted: true
    })
  })

  it('an UNKNOWN notification type is a no-op — a future type must not stick a badge', () => {
    expect(normalizeGrok(env({ hookEventName: 'notification', notificationType: 'auth_success' }))).toBeNull()
    expect(normalizeGrok(env({ hookEventName: 'notification' }))).toBeNull()
  })
})

describe('normalizeGrok — dialects', () => {
  it('reads the SDK snake_case key spelling too', () => {
    expect(
      normalizeGrok(env({ hook_event_name: 'stop', session_id: 's9', last_assistant_message: 'ok' }))
    ).toMatchObject({ sessionId: 's9', state: 'done', lastMessage: 'ok' })
  })

  it('accepts a PascalCase event name (canonicalized, not matched literally)', () => {
    expect(normalizeGrok(env({ hookEventName: 'PreToolUse' }))).toMatchObject({ state: 'working' })
  })

  it('ignores events we do not subscribe to yet', () => {
    for (const ev of ['pre_compact', 'post_compact', 'subagent_start', 'subagent_stop', 'permission_denied']) {
      expect(normalizeGrok(env({ hookEventName: ev, sessionId: 's1' })), ev).toBeNull()
    }
  })
})

/**
 * Grok also merges `~/.claude/settings.json`, where nodeterm's CLAUDE managed hook already lives —
 * so every grok event ALSO fires claude.sh and POSTs to /hook/claude. That leg must stay inert:
 * this is the test that keeps it a property instead of a coincidence.
 */
describe('the claude-compat cross-fire is inert', () => {
  it('normalizeClaude returns null for every grok payload', () => {
    for (const ev of ['session_start', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'stop', 'session_end']) {
      expect(
        normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: { hookEventName: ev, sessionId: 's1' } }),
        ev
      ).toBeNull()
    }
  })
})

describe('grokRawFields', () => {
  it('hands the shells ONE canonical field set from either dialect', () => {
    expect(
      grokRawFields({
        hookEventName: 'pre_tool_use',
        sessionId: 's1',
        cwd: '/w',
        toolName: 'spawn_subagent',
        toolUseId: 't1',
        toolInput: { subagent_type: 'explore' }
      })
    ).toEqual({
      event: 'pretooluse',
      sessionId: 's1',
      cwd: '/w',
      toolName: 'spawn_subagent',
      toolUseId: 't1',
      toolInput: { subagent_type: 'explore' }
    })
    expect(grokRawFields({ hook_event_name: 'session_end', session_id: 's2' })).toMatchObject({
      event: 'sessionend',
      sessionId: 's2'
    })
  })
})
