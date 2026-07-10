import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { claudeConfigDirFor } from './claude-config-dir'

beforeEach(() => initPlatform(fakePlatform({ userDataDir: '/tmp/ud' })))
afterEach(() => resetPlatformForTests())

describe('claudeConfigDirFor', () => {
  // NOTE: the actual current signature in claude-accounts.ts is
  // `claudeConfigDirFor(accountId: string): string` — accountId is REQUIRED and the
  // return is always a string. Every caller guards (`accountId ? claudeConfigDirFor(id) : …`)
  // so undefined never reaches it. This test documents that ACTUAL behavior; the refactor
  // must not change it.
  it('an account id resolves under userData/claude-accounts', () => {
    expect(claudeConfigDirFor('abc')).toContain('/tmp/ud')
    expect(claudeConfigDirFor('abc')).toContain('abc')
    expect(claudeConfigDirFor('abc')).toBe('/tmp/ud/claude-accounts/abc')
  })

  it('reads userDataDir lazily from the platform seam', () => {
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: '/other/ud' }))
    expect(claudeConfigDirFor('xyz')).toBe('/other/ud/claude-accounts/xyz')
  })

  it('rejects a traversal-shaped account id (id validation preserved)', () => {
    expect(() => claudeConfigDirFor('../escape')).toThrow(/invalid account id/)
  })

  // Passing undefined is a type error at call sites; at runtime it throws (path.join on
  // undefined) rather than returning undefined — documenting that callers must guard.
  it('throws when accountId is missing (callers must guard)', () => {
    expect(() => claudeConfigDirFor(undefined as unknown as string)).toThrow()
  })
})
