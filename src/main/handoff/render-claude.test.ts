import { describe, it, expect } from 'vitest'
import { renderClaudeTranscript } from './render-claude'

const FIXTURE = [
  '{"type":"last-prompt","leafUuid":"x","sessionId":"s"}',
  '{"type":"user","message":{"role":"user","content":"hello there"}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi back"},{"type":"tool_use","name":"Read","input":{"file_path":"/a.ts"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"LINE1\\nLINE2"}]}]}}'
].join('\n')

describe('renderClaudeTranscript', () => {
  it('renders all turns, tool calls, and full tool output in order', () => {
    const md = renderClaudeTranscript(FIXTURE)
    expect(md).toContain('## User\n\nhello there')
    expect(md).toContain('## Assistant\n\nhi back')
    expect(md).toContain('Tool call: Read')
    expect(md).toContain('/a.ts')
    expect(md).toContain('Tool result')
    expect(md).toContain('LINE1')
    expect(md).toContain('LINE2') // no truncation of tool output
    expect(md.indexOf('hello there')).toBeLessThan(md.indexOf('hi back'))
  })

  it('skips metadata lines and tolerates malformed JSON', () => {
    const md = renderClaudeTranscript('{"type":"mode","mode":"normal"}\nnot json\n')
    expect(md).toBe('')
  })

  it('renders a string tool_result in full and JSON-emits unknown content blocks (no silent drop)', () => {
    const raw = [
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"PLAIN_STRING_RESULT"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"image","source":"data:UNKNOWN_SRC_42"}]}}'
    ].join('\n')
    const md = renderClaudeTranscript(raw)
    // (a) string tool_result content is rendered in full
    expect(md).toContain('PLAIN_STRING_RESULT')
    // (b) unknown assistant block falls back to JSON, not dropped
    expect(md).toContain('Assistant block (image)')
    expect(md).toContain('UNKNOWN_SRC_42')
    expect(md).toContain('"image"')
  })
})
