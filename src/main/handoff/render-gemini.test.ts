import { describe, it, expect } from 'vitest'
import { renderGeminiTranscript } from './render-gemini'

const FIXTURE = [
  '{"sessionId":"2b5a774c-6d8a-4d9e-80e8-d14a00997a2c","projectHash":"abc","kind":"main"}',
  '{"$set":{"messages":[{"id":"a","type":"user","content":[{"text":"<session_context>setup</session_context>"}]}]}}',
  '{"id":"b","type":"user","content":[{"text":"how are you ?"}]}',
  '{"id":"c","type":"gemini","content":[{"text":"I am well."}]}'
].join('\n')

describe('renderGeminiTranscript', () => {
  it('reconstructs messages from $set baseline + bare appends, in order', () => {
    const md = renderGeminiTranscript(FIXTURE)
    expect(md).toContain('session_context')
    expect(md).toContain('## User\n\nhow are you ?')
    expect(md).toContain('## Assistant\n\nI am well.')
    expect(md.indexOf('how are you ?')).toBeLessThan(md.indexOf('I am well.'))
    expect(md).not.toContain('projectHash')
  })

  it('appends a $push message after the $set baseline, in order (no silent drop)', () => {
    const raw = [
      '{"$set":{"messages":[{"id":"a","type":"user","content":[{"text":"BASELINE_MSG"}]}]}}',
      '{"$push":{"messages":[{"id":"b","type":"gemini","content":[{"text":"PUSHED_MSG"}]}]}}'
    ].join('\n')
    const md = renderGeminiTranscript(raw)
    expect(md).toContain('BASELINE_MSG')
    expect(md).toContain('PUSHED_MSG')
    expect(md.indexOf('BASELINE_MSG')).toBeLessThan(md.indexOf('PUSHED_MSG'))
  })
})
