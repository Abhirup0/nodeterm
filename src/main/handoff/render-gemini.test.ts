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
})
