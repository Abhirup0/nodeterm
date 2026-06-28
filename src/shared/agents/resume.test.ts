import { describe, it, expect } from 'vitest'
import { resumeCommand } from './config'

describe('resumeCommand', () => {
  it('builds claude resume', () => {
    expect(resumeCommand('claude', 'abc-123')).toBe('claude --resume abc-123')
  })

  it('builds codex resume (subcommand form)', () => {
    expect(resumeCommand('codex', 'abc-123')).toBe('codex resume abc-123')
  })

  it('builds gemini resume', () => {
    expect(resumeCommand('gemini', 'abc-123')).toBe('gemini --resume abc-123')
  })

  it('returns null for a non-resumable / custom agent', () => {
    expect(resumeCommand('custom:xyz', 'abc-123')).toBeNull()
  })

  it('returns null when the session id is missing or empty', () => {
    expect(resumeCommand('claude', '')).toBeNull()
    expect(resumeCommand('claude', '   ')).toBeNull()
  })

  it('rejects an unsafe session id (shell metacharacters / flag-like)', () => {
    expect(resumeCommand('claude', '-rf /')).toBeNull()
    expect(resumeCommand('claude', 'a; rm -rf /')).toBeNull()
    expect(resumeCommand('claude', 'a$(whoami)')).toBeNull()
    expect(resumeCommand('claude', 'a b')).toBeNull()
  })
})
