import { describe, it, expect } from 'vitest'
import { normalizeClaude, type RawHookEnvelope } from './normalize'

function env(payload: Record<string, unknown>): RawHookEnvelope {
  return { nodeId: 'n1', agentId: 'claude', payload }
}

describe('normalizeClaude — turn-end signals', () => {
  it('Stop → done, not interrupted', () => {
    const e = normalizeClaude(env({ hook_event_name: 'Stop', session_id: 's1' }))
    expect(e).toMatchObject({ kind: 'state', state: 'done', sessionId: 's1' })
    expect(e?.interrupted).toBeFalsy()
  })

  it('Stop with is_interrupt → done + interrupted (user pressed Esc)', () => {
    const e = normalizeClaude(env({ hook_event_name: 'Stop', is_interrupt: true }))
    expect(e).toMatchObject({ kind: 'state', state: 'done', interrupted: true })
  })

  // Claude Code skips the normal Stop hook when the turn dies on an API/model error and
  // fires StopFailure instead — without mapping it, the badge sticks on RUNNING forever.
  it('StopFailure → done (API-error turn end)', () => {
    const e = normalizeClaude(env({ hook_event_name: 'StopFailure' }))
    expect(e).toMatchObject({ kind: 'state', state: 'done' })
  })
})

describe('normalizeClaude — async subagents', () => {
  it('PostToolUse for a sync subagent → subagent-end with stats', () => {
    const e = normalizeClaude(
      env({
        hook_event_name: 'PostToolUse',
        tool_name: 'Task',
        tool_use_id: 'tu1',
        tool_response: { content: [{ type: 'text', text: 'the answer' }], totalDurationMs: 1200 }
      })
    )
    expect(e).toMatchObject({ kind: 'subagent-end', toolUseId: 'tu1', durationMs: 1200, result: 'the answer' })
  })

  // Claude Code launches subagents async by default: PostToolUse fires ~immediately with a
  // launch acknowledgment ({isAsync, status:'async_launched'}), NOT the finished result. That
  // must not end the card — the real end arrives later via the parent's <task-notification>.
  it('PostToolUse for an async launch → NOT subagent-end (card stays working)', () => {
    const e = normalizeClaude(
      env({
        hook_event_name: 'PostToolUse',
        tool_name: 'Task',
        tool_use_id: 'tu1',
        tool_response: { isAsync: true, status: 'async_launched', agentId: 'a1' }
      })
    )
    expect(e?.kind).not.toBe('subagent-end')
    expect(e).toMatchObject({ kind: 'state', state: 'working' })
  })

  it('UserPromptSubmit → working with newTurn', () => {
    const e = normalizeClaude(env({ hook_event_name: 'UserPromptSubmit', prompt: 'do things' }))
    expect(e).toMatchObject({ kind: 'state', state: 'working', newTurn: true, task: 'do things' })
  })

  // A completed async subagent is delivered back as a queued <task-notification> prompt.
  // That is not a genuine user turn: flagging it newTurn would clear the whole subagent
  // fan-out at the exact moment one of the cards completes.
  it('UserPromptSubmit of a <task-notification> → working but NOT a new turn', () => {
    const e = normalizeClaude(
      env({
        hook_event_name: 'UserPromptSubmit',
        prompt: '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>tu1</tool-use-id>\n</task-notification>'
      })
    )
    expect(e).toMatchObject({ kind: 'state', state: 'working' })
    expect(e?.newTurn).toBeFalsy()
  })
})

describe('normalizeClaude — permission signals', () => {
  it('PermissionRequest → blocked', () => {
    const e = normalizeClaude(env({ hook_event_name: 'PermissionRequest' }))
    expect(e).toMatchObject({ kind: 'state', state: 'blocked' })
  })

  it('Notification permission_prompt still maps to blocked', () => {
    const e = normalizeClaude(
      env({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })
    )
    expect(e).toMatchObject({ kind: 'state', state: 'blocked' })
  })
})
