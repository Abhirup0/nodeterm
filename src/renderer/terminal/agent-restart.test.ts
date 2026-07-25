import { describe, expect, it } from 'vitest'
import { exitSequence, isShellCommand, restartEligibility } from './agent-restart'

describe('exitSequence', () => {
  it('knows claude and codex, refuses others', () => {
    expect(exitSequence('claude')).toBe('/exit')
    expect(exitSequence('codex')).toBe('/quit')
    expect(exitSequence('gemini')).toBeNull()
    expect(exitSequence('my-custom')).toBeNull()
  })
})

describe('isShellCommand', () => {
  it('matches plain, login-dash and path-prefixed shells', () => {
    for (const c of ['zsh', 'bash', 'sh', 'fish', '-zsh', '/bin/bash', '/usr/local/bin/fish'])
      expect(isShellCommand(c)).toBe(true)
  })
  it('rejects agents, editors and empty', () => {
    for (const c of ['claude', 'codex', 'node', 'vim', '', null, undefined])
      expect(isShellCommand(c as never)).toBe(false)
  })
})

describe('restartEligibility', () => {
  it('ok for a resumable agent with a session id in a non-working state', () => {
    expect(restartEligibility('claude', 'waiting', 'abc-123')).toEqual({ ok: true })
    expect(restartEligibility('codex', 'done', 'abc-123')).toEqual({ ok: true })
  })
  it('treats a blocked (permission prompt) session as busy — /exit would answer the prompt', () => {
    expect(restartEligibility('claude', 'blocked', 'abc')).toEqual({ ok: false, reason: 'working' })
  })
  it('flags working / missing session / non-resumable, in that priority', () => {
    expect(restartEligibility('claude', 'working', 'abc')).toEqual({ ok: false, reason: 'working' })
    expect(restartEligibility('claude', 'waiting', undefined)).toEqual({
      ok: false,
      reason: 'no-session'
    })
    expect(restartEligibility('gemini', 'waiting', 'abc')).toEqual({
      ok: false,
      reason: 'not-resumable'
    })
    expect(restartEligibility(undefined, undefined, undefined)).toEqual({
      ok: false,
      reason: 'not-resumable'
    })
  })
})
