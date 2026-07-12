import { describe, expect, it } from 'vitest'
import { isSupportedClaudeVersion } from '../claude-accounts-core'
import { supportsAutoPermissionMode } from '../../shared/agents/config'
import {
  CLAUDE_VERSION_END,
  CLAUDE_VERSION_START,
  claudeVersionProbeCommand,
  parseClaudeVersionProbe
} from './claude-version-probe'

const wrap = (v: string): string => `${CLAUDE_VERSION_START}${v}${CLAUDE_VERSION_END}`

describe('claudeVersionProbeCommand', () => {
  it('prints the version between markers, through the login shell with a plain-shell fallback', () => {
    const cmd = claudeVersionProbeCommand()
    expect(cmd).toContain('$SHELL -lc')
    expect(cmd).toContain('sh -c')
    expect(cmd).toContain(CLAUDE_VERSION_START)
    expect(cmd).toContain(CLAUDE_VERSION_END)
    expect(cmd).toContain('claude --version')
  })
})

describe('parseClaudeVersionProbe', () => {
  it('reads the delimited value', () => {
    expect(parseClaudeVersionProbe(wrap('2.1.90 (Claude Code)'))).toBe('2.1.90 (Claude Code)')
  })

  it('ignores login-profile noise printed around the markers', () => {
    const noisy = [
      'Welcome — Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-89-generic x86_64)',
      'kernel 6.8.0-106-generic',
      'pyenv: version 3.11.6 activated',
      wrap('2.0.30 (Claude Code)'),
      'have a nice day 9.9.9'
    ].join('\n')
    expect(parseClaudeVersionProbe(noisy)).toBe('2.0.30 (Claude Code)')
  })

  it('treats missing markers as a FAILED probe (never "modern CLI")', () => {
    // The exact merge-blocker: a profile banner on stdout with no claude output at all.
    expect(parseClaudeVersionProbe('Welcome — Ubuntu 22.04.3 LTS')).toBeNull()
    expect(parseClaudeVersionProbe(`${CLAUDE_VERSION_START}2.1.90`)).toBeNull() // truncated
    expect(parseClaudeVersionProbe(wrap('  '))).toBeNull()
    expect(parseClaudeVersionProbe('')).toBeNull()
    expect(parseClaudeVersionProbe(null)).toBeNull()
  })

  it('banner-contaminated output never reports auto support, nor a supported account CLI', () => {
    // Old remote CLI (2.0.30) behind an Ubuntu banner: the ONLY version the consumers may see is
    // claude's own, so both gates say "old" — no `--permission-mode auto`, keychain warning kept.
    const noisy = `Welcome — Ubuntu 22.04.3 LTS\n${wrap('2.0.30 (Claude Code)')}`
    const version = parseClaudeVersionProbe(noisy)
    expect(supportsAutoPermissionMode(version)).toBe(false)
    expect(isSupportedClaudeVersion(version ?? '')).toBe(false)

    // …and a banner with no claude output at all parses to null, which every caller treats as
    // "unknown" (fail-open: no flag).
    expect(supportsAutoPermissionMode(parseClaudeVersionProbe('Welcome — Ubuntu 22.04.3 LTS'))).toBe(
      false
    )
  })

  it('a modern CLI behind a banner still reports auto support', () => {
    const noisy = `neofetch 7.1.0\n${wrap('2.1.90 (Claude Code)')}\n`
    expect(supportsAutoPermissionMode(parseClaudeVersionProbe(noisy))).toBe(true)
  })
})
