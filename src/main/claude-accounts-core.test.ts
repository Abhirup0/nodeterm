import { describe, expect, it } from 'vitest'
import {
  accountConfigDir,
  claudeKeychainService,
  usageCredsPaths,
  AUTH_ENV_STRIP,
  accountTmuxEnvArgs,
  parseLoginCapture,
  isSupportedClaudeVersion,
  transcriptRootFor
} from './claude-accounts-core'

describe('accountConfigDir', () => {
  it('maps an account id under userData/claude-accounts', () => {
    expect(accountConfigDir('/Users/x/Library/Application Support/nodeterm', 'a1')).toBe(
      '/Users/x/Library/Application Support/nodeterm/claude-accounts/a1'
    )
  })
  it('rejects ids that could traverse out of the root', () => {
    expect(() => accountConfigDir('/ud', '../evil')).toThrow()
    expect(() => accountConfigDir('/ud', 'a/b')).toThrow()
    expect(() => accountConfigDir('/ud', '')).toThrow()
  })
})

describe('claudeKeychainService', () => {
  // Claude Code ≥ 2.1 scopes the macOS Keychain service per config dir:
  // 'Claude Code-credentials-' + first 8 hex chars of sha256(configDir).
  it('appends the first 8 hex of sha256(configDir)', () => {
    const svc = claudeKeychainService('/ud/claude-accounts/a1')
    expect(svc).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
  })
  it('is deterministic per dir and differs across dirs', () => {
    expect(claudeKeychainService('/a')).toBe(claudeKeychainService('/a'))
    expect(claudeKeychainService('/a')).not.toBe(claudeKeychainService('/b'))
  })
})

describe('usageCredsPaths', () => {
  it('without a config dir uses the legacy unscoped services + ~/.claude paths', () => {
    expect(usageCredsPaths('/Users/x')).toEqual({
      services: ['Claude Code-credentials', 'claudeAiOauth'],
      credsFile: '/Users/x/.claude/.credentials.json',
      identityFile: '/Users/x/.claude.json'
    })
  })
  it('with a config dir puts the scoped service first + reads that dir', () => {
    const configDir = '/ud/claude-accounts/a1'
    const p = usageCredsPaths('/Users/x', configDir)
    expect(p.services).toEqual([
      claudeKeychainService(configDir),
      'Claude Code-credentials',
      'claudeAiOauth'
    ])
    expect(p.credsFile).toBe('/ud/claude-accounts/a1/.credentials.json')
    expect(p.identityFile).toBe('/ud/claude-accounts/a1/.claude.json')
  })
})

describe('AUTH_ENV_STRIP', () => {
  it('covers the env vars that would shadow the account OAuth login', () => {
    expect(AUTH_ENV_STRIP).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
    )
  })
})

describe('accountTmuxEnvArgs', () => {
  it('emits one -e pair for CLAUDE_CONFIG_DIR', () => {
    expect(accountTmuxEnvArgs('/ud/claude-accounts/a1')).toEqual([
      '-e',
      'CLAUDE_CONFIG_DIR=/ud/claude-accounts/a1'
    ])
  })
})

describe('parseLoginCapture', () => {
  it('extracts the email from oauthAccount', () => {
    const raw = JSON.stringify({ oauthAccount: { emailAddress: 'work@example.com' } })
    expect(parseLoginCapture(raw)).toEqual({ email: 'work@example.com' })
  })
  it('accepts the alternate `email` key', () => {
    const raw = JSON.stringify({ oauthAccount: { email: 'e@x.com' } })
    expect(parseLoginCapture(raw)).toEqual({ email: 'e@x.com' })
  })
  it('returns null while login has not completed', () => {
    expect(parseLoginCapture('{}')).toBeNull()
    expect(parseLoginCapture('not json')).toBeNull()
    expect(parseLoginCapture(JSON.stringify({ oauthAccount: {} }))).toBeNull()
  })
})

describe('transcriptRootFor', () => {
  it('defaults to the system ~/.claude/projects when no account', () => {
    expect(transcriptRootFor('/Users/x', null)).toBe('/Users/x/.claude/projects')
    expect(transcriptRootFor('/Users/x', '/ud', undefined)).toBe('/Users/x/.claude/projects')
  })
  it('uses the account config dir + projects when an account id is given', () => {
    expect(transcriptRootFor('/Users/x', '/ud', 'a1')).toBe('/ud/claude-accounts/a1/projects')
  })
  it('rejects account ids that could traverse out of the root', () => {
    expect(() => transcriptRootFor('/Users/x', '/ud', '../evil')).toThrow()
  })
})

describe('isSupportedClaudeVersion', () => {
  it('accepts 2.1+ and rejects older', () => {
    expect(isSupportedClaudeVersion('2.1.0 (Claude Code)')).toBe(true)
    expect(isSupportedClaudeVersion('2.10.3 (Claude Code)')).toBe(true)
    expect(isSupportedClaudeVersion('3.0.0')).toBe(true)
    expect(isSupportedClaudeVersion('2.0.14 (Claude Code)')).toBe(false)
    expect(isSupportedClaudeVersion('1.0.44')).toBe(false)
    expect(isSupportedClaudeVersion('garbage')).toBe(false) // unparseable → unsupported (warn)
  })
})
