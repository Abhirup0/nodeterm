import { describe, expect, it } from 'vitest'
import { normalizeGemini } from './normalize'
import { GEMINI_HOOK_EVENTS } from './hook-events'
import type { RawHookEnvelope } from './normalize'

/**
 * Every field here is measured against gemini 0.54.4's OWN bundled hook reference,
 * `/usr/lib/node_modules/@google/gemini-cli/bundle/docs/hooks/reference.md` — cited per case.
 * The envelope is snake_case and claude-shaped (reference.md:48-58).
 */
const env = (payload: Record<string, unknown>): RawHookEnvelope => ({
  nodeId: 'n1',
  agentId: 'gemini',
  payload
})

describe('normalizeGemini — the permission prompt (reference.md:272-285)', () => {
  it('maps a ToolPermission notification to blocked', () => {
    const e = normalizeGemini(
      env({
        hook_event_name: 'Notification',
        session_id: 's1',
        notification_type: 'ToolPermission',
        message: 'Allow run_shell_command?'
      })
    )
    expect(e).toMatchObject({
      kind: 'state',
      state: 'blocked',
      sessionId: 's1',
      lastMessage: 'Allow run_shell_command?'
    })
  })

  it('leaves an UNKNOWN notification type alone', () => {
    // The docs name exactly one type. An unknown future one must not stick a badge on a node —
    // the failure grok's substring match actually produced.
    for (const t of ['Info', 'Warning', 'SomethingNew', undefined]) {
      expect(normalizeGemini(env({ hook_event_name: 'Notification', notification_type: t })), String(t)).toBeNull()
    }
    // A CLOSED match, not a substring: a longer type that merely CONTAINS the documented word is
    // still unknown. Without this line a widening to `includes('Permission')` passes every test.
    expect(
      normalizeGemini(env({ hook_event_name: 'Notification', notification_type: 'ToolPermissionGranted' }))
    ).toBeNull()
  })
})

describe('normalizeGemini — session lifecycle', () => {
  it('maps SessionStart to the start phase for every documented source', () => {
    for (const source of ['startup', 'resume', 'clear']) {
      expect(normalizeGemini(env({ hook_event_name: 'SessionStart', session_id: 's1', source })), source).toMatchObject(
        { kind: 'session', sessionPhase: 'start' }
      )
    }
  })

  it('maps SessionEnd to the end phase for every documented reason', () => {
    for (const reason of ['exit', 'clear', 'logout', 'prompt_input_exit', 'other']) {
      expect(normalizeGemini(env({ hook_event_name: 'SessionEnd', session_id: 's1', reason })), reason).toMatchObject(
        { kind: 'session', sessionPhase: 'end' }
      )
    }
  })
})

describe('normalizeGemini — what must not change', () => {
  it('still maps its turn and tool events exactly as before', () => {
    expect(normalizeGemini(env({ hook_event_name: 'BeforeAgent', session_id: 's1' }))).toMatchObject({
      state: 'working',
      newTurn: true
    })
    for (const ev of ['BeforeTool', 'AfterTool']) {
      expect(normalizeGemini(env({ hook_event_name: ev })), ev).toMatchObject({ state: 'working' })
    }
    expect(normalizeGemini(env({ hook_event_name: 'AfterAgent' }))).toMatchObject({ state: 'done' })
  })

  it('reads the legacy key spellings the normalizer already accepted', () => {
    expect(normalizeGemini(env({ hookEventName: 'AfterAgent' }))).toMatchObject({ state: 'done' })
    expect(normalizeGemini(env({ event: 'AfterAgent' }))).toMatchObject({ state: 'done' })
  })

  it('does NOT subscribe to AfterModel — it fires per streamed chunk', () => {
    // reference.md:236-237. One hook process per chunk is a performance defect; the token numbers
    // come off the transcript instead (Task 3). The other three are left out because they report
    // no state we render — `BeforeModel` fires once per model request (reference.md:187-190), not
    // per chunk. All four of gemini's unsubscribed events, spelled out.
    expect(GEMINI_HOOK_EVENTS).not.toContain('AfterModel')
    expect(GEMINI_HOOK_EVENTS).not.toContain('BeforeModel')
    expect(GEMINI_HOOK_EVENTS).not.toContain('BeforeToolSelection')
    expect(GEMINI_HOOK_EVENTS).not.toContain('PreCompress')
  })

  it('subscribes to exactly the seven events we can act on', () => {
    expect([...GEMINI_HOOK_EVENTS].sort()).toEqual(
      ['AfterAgent', 'AfterTool', 'BeforeAgent', 'BeforeTool', 'Notification', 'SessionEnd', 'SessionStart'].sort()
    )
  })
})
