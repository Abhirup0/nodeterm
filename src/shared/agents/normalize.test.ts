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
