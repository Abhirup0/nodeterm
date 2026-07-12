import { describe, it, expect } from 'vitest'
import { claudeCliCapsFrom, UNKNOWN_CLAUDE_CLI_CAPS } from './claude-cli'

describe('claudeCliCapsFrom', () => {
  it('reads a real `claude --version` line', () => {
    expect(claudeCliCapsFrom('2.1.207 (Claude Code)\n')).toEqual({
      version: '2.1.207 (Claude Code)',
      autoPermissionMode: true
    })
  })

  it('marks an older CLI as not knowing `auto` (it would exit 1 on the flag value)', () => {
    expect(claudeCliCapsFrom('2.1.50 (Claude Code)')).toEqual({
      version: '2.1.50 (Claude Code)',
      autoPermissionMode: false
    })
  })

  it('collapses no output to the fail-open caps (no version → no auto → bare command)', () => {
    expect(claudeCliCapsFrom(null)).toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
    expect(claudeCliCapsFrom(undefined)).toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
    expect(claudeCliCapsFrom('   ')).toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
  })

  it('never claims `auto` from output it cannot parse a version out of', () => {
    // `version` is diagnostic only (it's whatever the CLI printed); the load-bearing field is the
    // capability, which must stay false for anything that isn't a readable version.
    expect(claudeCliCapsFrom('claude: command not found').autoPermissionMode).toBe(false)
    expect(claudeCliCapsFrom('some unrelated banner').autoPermissionMode).toBe(false)
  })
})
