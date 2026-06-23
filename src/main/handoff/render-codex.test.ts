import { describe, it, expect } from 'vitest'
import { renderCodexTranscript } from './render-codex'

const FIXTURE = [
  '{"timestamp":"t","type":"session_meta","payload":{"id":"019edbd1"}}',
  '{"timestamp":"t","type":"event_msg","payload":{"type":"task_started"}}',
  '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"do the thing"}]}}',
  '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"working on it"}]}}',
  '{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\\"cmd\\":\\"ls\\"}"}}',
  '{"type":"response_item","payload":{"type":"function_call_output","output":"file1\\nfile2"}}'
].join('\n')

describe('renderCodexTranscript', () => {
  it('renders messages, tool calls, and full outputs; skips chrome', () => {
    const md = renderCodexTranscript(FIXTURE)
    expect(md).toContain('## User\n\ndo the thing')
    expect(md).toContain('## Assistant\n\nworking on it')
    expect(md).toContain('Tool call: shell')
    expect(md).toContain('cmd')
    expect(md).toContain('Tool result')
    expect(md).toContain('file1')
    expect(md).toContain('file2')
    expect(md).not.toContain('task_started')
  })
})
