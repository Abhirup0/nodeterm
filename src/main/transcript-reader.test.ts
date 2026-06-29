import { describe, expect, it } from 'vitest'
import { parseTranscriptLines } from './transcript-reader'
import type { TranscriptLine } from '../shared/types'

describe('parseTranscriptLines', () => {
  it('maps each JSONL line to TranscriptLine[] (role/text), mirroring the reader', () => {
    const text = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/a/b/workspace.ts' } }
          ]
        }
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'do it' },
            { type: 'tool_result', content: 'line one\nline two\nline three\nline four' }
          ]
        }
      }),
      JSON.stringify({ type: 'user', message: { content: 'plain user' } }),
      '',
      'garbled'
    ].join('\n')
    const expected: TranscriptLine[] = [
      { role: 'assistant', text: 'hello' },
      { role: 'tool', text: '$ Read /a/b/workspace.ts' },
      { role: 'user', text: 'do it' },
      { role: 'tool', text: 'line one line two line three' },
      { role: 'user', text: 'plain user' }
    ]
    expect(parseTranscriptLines(text)).toEqual(expected)
  })
})
