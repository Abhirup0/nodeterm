import { describe, expect, it } from 'vitest'
import { formatSubagentChunk } from './subagent-tail'

describe('formatSubagentChunk', () => {
  it('formats assistant prose + tool_use across lines, dropping blanks/garbled', () => {
    const text = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      '',
      'garbled',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } })
    ].join('\n')
    // formatLine emits assistant text verbatim ('hi') and tool_use as `$ <name> <arg>` ('$ Bash ls');
    // the chunk joins surviving lines with '\n' (mirrors the tail's read loop exactly).
    expect(formatSubagentChunk(text)).toBe('hi\n$ Bash ls')
  })
})
