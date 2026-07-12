import fs from 'fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseTranscriptLines,
  pickSessionName,
  readSessionName,
  setRemoteTranscriptReader
} from './transcript-reader'
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

// An SSH project's Claude runs on the remote host, so its transcript .jsonl lives on the remote
// filesystem — the local scan can never find it. A registered remote reader (wired in main from
// the hook-fed transcript path) is consulted FIRST, so `/rename` on a remote node reaches the
// node title exactly like it does locally.
describe('readSessionName — remote (SSH project) sessions', () => {
  const sid = '11111111-2222-3333-4444-555555555555'
  const custom = (t: string) => JSON.stringify({ type: 'custom-title', customTitle: t, sessionId: sid })

  afterEach(() => setRemoteTranscriptReader(null))

  it('reads the name from the remote transcript when the session is remote', async () => {
    setRemoteTranscriptReader(async (id) =>
      id === sid ? { text: [custom('Ship the relay fix')].join('\n') } : null
    )
    expect(await readSessionName(sid)).toBe('Ship the relay fix')
  })

  // A remote session is never in the local ~/.claude/projects, so scanning it is pure waste —
  // and today's poll does exactly that every 4s, forever, for every SSH agent node.
  it('does not scan the local transcript root for a known remote session', async () => {
    const readdir = vi.spyOn(fs.promises, 'readdir')
    setRemoteTranscriptReader(async () => ({ text: '' }))
    expect(await readSessionName(sid)).toBeNull()
    expect(readdir).not.toHaveBeenCalled()
    readdir.mockRestore()
  })

  it('falls through to the local reader when the session is not remote', async () => {
    setRemoteTranscriptReader(async () => null)
    // No local transcript for this id either — the point is that it did not throw and the
    // remote branch declined, leaving today's local behavior intact.
    expect(await readSessionName(sid)).toBeNull()
  })
})
