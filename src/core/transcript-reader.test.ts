import { describe, expect, it } from 'vitest'
import { parseTranscriptLines, pickSessionName } from './transcript-reader'
import type { TranscriptLine } from '../shared/types'

describe('pickSessionName', () => {
  const ai = (t: string) => JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: 's' })
  const custom = (t: string) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: 's' })

  it('returns the auto name when no /rename title is present', () => {
    expect(pickSessionName([ai('First topic'), ai('Refined topic')].join('\n'))).toBe('Refined topic')
  })

  it('prefers the user /rename name over the auto name', () => {
    const text = [ai('auto'), custom('My Work'), ai('auto changed')].join('\n')
    expect(pickSessionName(text)).toBe('My Work')
  })

  it('uses the latest custom-title and trims it', () => {
    const text = [custom('old'), custom('  new  ')].join('\n')
    expect(pickSessionName(text)).toBe('new')
  })

  it('returns null when there is no title record (and ignores junk lines)', () => {
    expect(pickSessionName('not json\n{"type":"assistant"}\n')).toBeNull()
  })
})

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
