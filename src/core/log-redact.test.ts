import { describe, it, expect } from 'vitest'
import { redactSecrets, SECRET_VALUE_NAMES } from './log-redact'

describe('redactSecrets', () => {
  it('redacts every named credential in NAME=value form', () => {
    for (const name of SECRET_VALUE_NAMES) {
      const out = redactSecrets(`spawning with ${name}=super-secret-123 in env`)
      expect(out, name).not.toContain('super-secret-123')
      expect(out, name).toContain(`${name}=[redacted]`)
    }
  })

  it('redacts NAME: value and quoted JSON forms', () => {
    expect(redactSecrets('NODETERM_HOOK_TOKEN: abc123')).toBe('NODETERM_HOOK_TOKEN: [redacted]')
    const json = redactSecrets('{"access_token":"eyJhbGciOi.payload.sig","scope":"x"}')
    expect(json).not.toContain('eyJhbGciOi')
    expect(json).toContain('"scope":"x"')
  })

  it('redacts Authorization and X-Nodeterm-*-Token headers whatever the scheme', () => {
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toBe('Authorization: [redacted]')
    expect(redactSecrets('authorization: Basic dXNlcjpwYXNz')).toBe('authorization: [redacted]')
    expect(redactSecrets('X-Nodeterm-Hook-Token: tok123')).toBe('X-Nodeterm-Hook-Token: [redacted]')
    expect(redactSecrets('X-Nodeterm-Askpass-Token: tok123')).toBe('X-Nodeterm-Askpass-Token: [redacted]')
    expect(redactSecrets('cookie: session=abc; theme=dark')).toBe('cookie: [redacted]')
  })

  it('redacts bare well-known token shapes (argv echoes)', () => {
    expect(redactSecrets('ran curl -H x sk-ant-api03-abcdefghijklmnop')).not.toContain('sk-ant')
    expect(redactSecrets('cloning with ghp_abcdefghijklmnop1234')).not.toContain('ghp_')
    expect(redactSecrets('github_pat_11ABCDEFG_abcdefghijklmnop')).not.toContain('github_pat_')
  })

  it('leaves the debugging substance alone — SHAs, paths, node ids, ports', () => {
    const line =
      '[remote-hooks] installed for nt-4f2a at /home/u/.nodeterm on 127.0.0.1:53187 (commit 9c8f3bcf1234567890abcdef1234567890abcdef)'
    expect(redactSecrets(line)).toBe(line)
  })

  it('is idempotent', () => {
    const once = redactSecrets('GH_TOKEN=abc Authorization: Bearer x')
    expect(redactSecrets(once)).toBe(once)
  })
})
