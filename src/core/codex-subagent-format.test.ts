import { describe, expect, it } from 'vitest'
import { createCodexSubagentFormatter } from './codex-subagent-format'

// Every line shape below is from the LIVE spawn_agent capture on codex-cli 0.146.0
// (2026-08-24, single + parallel + nested runs), trimmed to the fields the formatter reads.
const j = (o: unknown): string => JSON.stringify(o)

const META = j({ type: 'inter_agent_communication_metadata', payload: { trigger_turn: true } })
const NEW_TASK = j({
  type: 'response_item',
  payload: {
    type: 'agent_message',
    author: '/root/agent_b',
    recipient: '/root/agent_b/nested_echo',
    content: [
      { type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/agent_b/nested_echo\nSender: /root/agent_b\nPayload:\n' },
      { type: 'encrypted_content', encrypted_content: 'gAAAAABqjFoIEMsnnu…' }
    ]
  }
})
const PROSE = j({
  type: 'event_msg',
  payload: { type: 'agent_message', message: 'I’m running the exact command now.', phase: 'commentary' }
})
const TOOL = j({
  type: 'response_item',
  payload: { type: 'custom_tool_call', name: 'exec', input: 'echo hello-from-subagent', call_id: 'call_1' }
})
const TOOL_OUT = j({
  type: 'response_item',
  payload: {
    type: 'custom_tool_call_output',
    call_id: 'call_1',
    output: [
      { type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' },
      { type: 'input_text', text: 'hello-from-subagent\n' }
    ]
  }
})
const FN_CALL = j({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'spawn_agent',
    namespace: 'collaboration',
    arguments: '{"task_name":"nested_echo","fork_turns":"all","message":"gAAAAABqjFoIEMsn…"}'
  }
})
const FN_OUT = j({
  type: 'response_item',
  payload: { type: 'function_call_output', output: '{"task_name":"/root/agent_b/nested_echo"}' }
})
const NESTED = j({
  type: 'event_msg',
  payload: {
    type: 'sub_agent_activity',
    event_id: 'call_X',
    agent_thread_id: '01a0343f-8ceb-7141-8d24-978ddea92bef',
    agent_path: '/root/agent_a',
    kind: 'started'
  }
})
// Fork-replay lines that precede the task delivery — the PARENT's context, never the child's work.
const REPLAY_META = j({ type: 'session_meta', payload: {} })
const REPLAY_PROSE = j({
  type: 'event_msg',
  payload: { type: 'agent_message', message: 'I’ll delegate exactly that shell command…' }
})
const REPLAY_USER = j({ type: 'event_msg', payload: { type: 'user_message', message: 'Please use spawn_agent…' } })
const TOKENS = j({ type: 'event_msg', payload: { type: 'token_count', info: {} } })

describe('createCodexSubagentFormatter', () => {
  it('suppresses the fork-replay prefix until the task delivery, then streams the child work', () => {
    const fmt = createCodexSubagentFormatter()
    const out = fmt([REPLAY_META, REPLAY_PROSE, REPLAY_USER, META, NEW_TASK, PROSE, TOOL, TOOL_OUT].join('\n'))
    expect(out).toBe(
      [
        'Task: /root/agent_b/nested_echo',
        'I’m running the exact command now.',
        '$ exec echo hello-from-subagent',
        '  ↳ Script completed … (+3 lines)'
      ].join('\n')
    )
    // Nothing replayed leaked through.
    expect(out).not.toContain('delegate')
  })

  it('the gate is stateful ACROSS chunks — replay in chunk 1, work in chunk 2', () => {
    const fmt = createCodexSubagentFormatter()
    expect(fmt([REPLAY_PROSE, REPLAY_USER].join('\n'))).toBe('')
    expect(fmt(META + '\n')).toBe('')
    expect(fmt(PROSE + '\n')).toBe('I’m running the exact command now.')
  })

  it('each formatter instance gates independently (two concurrent subagents)', () => {
    const a = createCodexSubagentFormatter()
    const b = createCodexSubagentFormatter()
    a(META + '\n')
    // b never saw its gate — it must still suppress.
    expect(b(PROSE + '\n')).toBe('')
    expect(a(PROSE + '\n')).toBe('I’m running the exact command now.')
  })

  it('the NEW_TASK message itself opens the gate when no metadata line precedes it', () => {
    const fmt = createCodexSubagentFormatter()
    expect(fmt([REPLAY_PROSE, NEW_TASK, PROSE].join('\n'))).toBe(
      ['Task: /root/agent_b/nested_echo', 'I’m running the exact command now.'].join('\n')
    )
  })

  it('formats function_call with a readable arg and never the encrypted message', () => {
    const fmt = createCodexSubagentFormatter()
    const out = fmt([META, FN_CALL, FN_OUT].join('\n'))
    expect(out).toContain('$ spawn_agent nested_echo')
    expect(out).not.toContain('gAAAA')
    expect(out).toContain('↳ {"task_name":"/root/agent_b/nested_echo"}')
  })

  it('a nested spawn observed from this child is one ↪ line', () => {
    const fmt = createCodexSubagentFormatter()
    expect(fmt([META, NESTED].join('\n'))).toBe('↪ spawned /root/agent_a')
  })

  it('skips bookkeeping lines and survives torn/non-JSON input', () => {
    const fmt = createCodexSubagentFormatter()
    expect(fmt([META, TOKENS, '{not json', ''].join('\n'))).toBe('')
  })
})
