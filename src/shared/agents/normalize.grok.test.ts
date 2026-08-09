import { describe, expect, it } from 'vitest'
import { grokRawFields, normalizeClaude, normalizeGrok, type RawHookEnvelope } from './normalize'

/**
 * Grok's hook envelope is its own dialect: camelCase keys whose `hookEventName` VALUE is
 * snake_case ("pre_tool_use"), and the grok SDK path converts the top-level keys to snake_case.
 * Both spellings are therefore read, and the event name is canonicalized rather than matched
 * literally — measured against the shipped 1.0.0 docs, not inferred from claude's shape.
 */
function env(payload: Record<string, unknown>): RawHookEnvelope {
  return { nodeId: 'n1', agentId: 'grok', payload }
}

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

  /**
   * The two observe-only reasons are a DENYLIST, not 'end_turn' an allowlist: only grok's session
   * close is observe-only, so any turn-end reason grok labels later must still report its badge and
   * its completion alert. An allowlist would silently mark all of these `interrupted`.
   */
  it('an UNKNOWN reason is a real turn end too, alert and message intact', () => {
    for (const reason of ['max_tokens', 'refusal', 'something_new']) {
      const e = normalizeGrok(env({ hookEventName: 'stop', sessionId: 's1', reason, lastAssistantMessage: 'text' }))
      expect(e, reason).toMatchObject({ state: 'done', lastMessage: 'text' })
      expect(e?.interrupted, reason).toBeFalsy()
    }
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

  /**
   * The asking types are matched EXACTLY, not by substring: grok's vocabulary is claude-derived, and
   * claude's `elicitation_complete` / `elicitation_response` fire when an elicitation ENDS. A
   * substring test on 'elicit' would read those as a fresh ask and leave NEEDS YOU on a node that
   * just finished — the exact bug normalizeClaude's closed set exists to avoid
   * (normalize.test.ts, 'informational / unknown Notification types do not change state').
   */
  it('the elicitation END notifications are informational, NOT a new ask', () => {
    for (const type of ['elicitation_complete', 'elicitation_response', 'agent_completed']) {
      expect(normalizeGrok(env({ hookEventName: 'notification', notificationType: type })), type).toBeNull()
    }
    // The dialog OPENING is the one elicitation type that does ask.
    expect(
      normalizeGrok(env({ hookEventName: 'notification', notificationType: 'elicitation_dialog' }))
    ).toMatchObject({ state: 'waiting' })
  })

  it('reads the notification type in the SDK snake_case dialect too', () => {
    expect(
      normalizeGrok(env({ hook_event_name: 'notification', notification_type: 'permission_prompt' }))
    ).toMatchObject({ state: 'blocked' })
    expect(
      normalizeGrok(env({ hook_event_name: 'notification', notification_type: 'agent_needs_input' }))
    ).toMatchObject({ state: 'waiting' })
    expect(
      normalizeGrok(env({ hook_event_name: 'notification', notification_type: 'idle_prompt' }))
    ).toMatchObject({ state: 'done', idle: true, interrupted: true })
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
  const GROK_EVENTS = ['session_start', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'stop', 'session_end']

  it('normalizeClaude returns null for every grok payload (camelCase dialect)', () => {
    for (const ev of GROK_EVENTS) {
      expect(
        normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: { hookEventName: ev, sessionId: 's1' } }),
        ev
      ).toBeNull()
    }
  })

  /**
   * This is the leg that actually carries the property: in the SDK dialect grok writes the key
   * claude DOES read (`hook_event_name`), so inertness rests entirely on claude's compare being
   * case-sensitive and literal — 'stop' is not 'Stop'. Anyone who "helpfully" lowercases claude's
   * event name breaks this and nothing else.
   */
  it('normalizeClaude returns null for every grok payload (SDK snake_case dialect)', () => {
    for (const ev of GROK_EVENTS) {
      expect(
        normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: { hook_event_name: ev, session_id: 's1' } }),
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
    // Every field the function reads, in the SDK dialect — dual-dialect reading is its whole reason
    // to exist, so dropping any one `?? p.snake_case` fallback has to fail here.
    expect(
      grokRawFields({
        hook_event_name: 'post_tool_use',
        session_id: 's2',
        cwd: '/w2',
        tool_name: 'read_file',
        tool_use_id: 't2',
        tool_input: { path: '/w2/a.ts' }
      })
    ).toEqual({
      event: 'posttooluse',
      sessionId: 's2',
      cwd: '/w2',
      toolName: 'read_file',
      toolUseId: 't2',
      toolInput: { path: '/w2/a.ts' }
    })
  })
})
