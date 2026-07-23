import { describe, it, expect } from 'vitest'
import { bracketedInjection, PASTE_START, PASTE_END } from './paste-injection'

describe('bracketedInjection', () => {
  it('frames the text in paste markers with the Enter in the same body', () => {
    expect(bracketedInjection('hello', true)).toBe(`${PASTE_START}hello${PASTE_END}\r`)
  })
  it('omits the Enter when not requested (dictation insert)', () => {
    expect(bracketedInjection('hello', false)).toBe(`${PASTE_START}hello${PASTE_END}`)
  })
  it('keeps multiline text inside one paste frame — newlines are content, not submits', () => {
    const body = bracketedInjection('line one\nline two', true)
    expect(body).toBe(`${PASTE_START}line one\nline two${PASTE_END}\r`)
    expect(body.indexOf('\r')).toBe(body.length - 1)
  })
})
