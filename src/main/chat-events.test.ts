import { describe, expect, it } from 'vitest'
import { sdkMessageToEvents, summarizeToolInput } from './chat-events'

describe('sdkMessageToEvents', () => {
  it('maps init system message to session event', () => {
    const ev = sdkMessageToEvents({
      type: 'system', subtype: 'init', session_id: 'abc', slash_commands: ['/compact']
    })
    expect(ev).toEqual([{ kind: 'session', sessionId: 'abc', slashCommands: ['/compact'] }])
  })

  it('maps text and thinking deltas', () => {
    expect(sdkMessageToEvents({
      type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'he' } }
    })).toEqual([{ kind: 'delta', block: 'text', text: 'he' }])
    expect(sdkMessageToEvents({
      type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } }
    })).toEqual([{ kind: 'delta', block: 'thinking', text: 'hm' }])
  })

  it('maps a completed assistant message to message + tool events', () => {
    const ev = sdkMessageToEvents({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'done' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a/b.ts', old_string: 'x\ny', new_string: 'z' } }
        ]
      }
    })
    expect(ev[0]).toEqual({ kind: 'message', msg: { role: 'assistant', parts: [{ kind: 'text', text: 'done' }] } })
    expect(ev[1]).toMatchObject({ kind: 'tool', toolUseId: 't1', name: 'Edit', summary: { filePath: '/a/b.ts' } })
  })

  it('maps tool results from user messages', () => {
    const ev = sdkMessageToEvents({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
    })
    expect(ev).toEqual([{ kind: 'tool-result', toolUseId: 't1', result: 'ok' }])
  })

  it('maps result to turn-done with cost and usage', () => {
    const ev = sdkMessageToEvents({
      type: 'result', subtype: 'success', total_cost_usd: 0.12,
      usage: { input_tokens: 10, output_tokens: 20 }
    })
    expect(ev).toEqual([{ kind: 'turn-done', costUsd: 0.12, usage: { inputTokens: 10, outputTokens: 20 } }])
  })

  it('maps error result subtypes to turn-done + error', () => {
    const ev = sdkMessageToEvents({ type: 'result', subtype: 'error_max_turns', total_cost_usd: 0.01 })
    expect(ev[0].kind).toBe('turn-done')
    expect(ev[1]).toMatchObject({ kind: 'error', fatal: false })
  })

  it('ignores unknown messages', () => {
    expect(sdkMessageToEvents({ type: 'whatever' })).toEqual([])
  })
})

describe('summarizeToolInput', () => {
  it('summarizes Edit with line counts from old/new strings', () => {
    const s = summarizeToolInput('Edit', { file_path: '/x.ts', old_string: 'a\nb', new_string: 'c' })
    expect(s.summary).toEqual({ filePath: '/x.ts', added: 1, removed: 2 })
    expect(s.arg).toBe('/x.ts')
  })
  it('summarizes Write as all-added', () => {
    const s = summarizeToolInput('Write', { file_path: '/x.ts', content: 'a\nb\nc' })
    expect(s.summary).toEqual({ filePath: '/x.ts', added: 3, removed: 0 })
  })
  it('falls back to a compact arg for other tools', () => {
    const s = summarizeToolInput('Bash', { command: 'ls -la' })
    expect(s.arg).toBe('ls -la')
    expect(s.summary).toBeUndefined()
  })
})
