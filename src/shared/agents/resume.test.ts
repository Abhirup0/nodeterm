import { describe, it, expect } from 'vitest'
import { resumeCommand, supportsSessionIdFlag, withSessionId } from './config'

describe('withSessionId', () => {
  it('appends the minted id for claude', () => {
    expect(withSessionId('claude', 'claude', 'abc-123')).toBe('claude --session-id abc-123')
  })

  it('leaves a non-capable agent byte-identical', () => {
    // grok is NOT in this list any more: it joined SESSION_ID_CAPABLE. An agent whose capability is
    // real must never stand as the example of one that lacks it — the example stops asserting
    // anything the day it changes, and this one was still passing for the wrong reason.
    for (const id of ['codex', 'gemini', 'opencode'] as const) {
      expect(withSessionId(id, id, 'abc-123')).toBe(id)
    }
  })

  it('spells grok\'s flag with a SPACE, not copilot\'s equals form', () => {
    // Two capable agents, two spellings. `withSessionId` branches on copilot alone, so grok takes
    // the space form claude uses — which is what `grok --help` documents.
    expect(withSessionId('grok', 'grok', 'abc-123')).toBe('grok --session-id abc-123')
  })

  it('uses Copilot\'s equals-form session id independently of the Claude probe', () => {
    expect(supportsSessionIdFlag('copilot', false, false)).toBe(true)
    expect(supportsSessionIdFlag('claude', false, false)).toBe(false)
    expect(supportsSessionIdFlag('claude', true, false)).toBe(true)
    expect(withSessionId('copilot', 'copilot', 'abc-123')).toBe(
      'copilot --session-id=abc-123'
    )
  })

  // The value reaches a tmux send-keys line, so the type is not the guard — the same reason
  // resumeCommand re-validates. A rejected id must yield the bare command, never a broken one.
  it('refuses an unsafe or empty id and returns the command unchanged', () => {
    for (const bad of ['', '   ', '-rf', 'a; rm -rf /', '$(id)', 'a b']) {
      expect(withSessionId('claude', 'claude', bad)).toBe('claude')
    }
  })

  it('accepts the uuid shape it will actually be given', () => {
    const u = '32f2b123-6b25-4ef0-9e05-afc8705ae1f9'
    expect(withSessionId('claude', 'claude', u)).toBe(`claude --session-id ${u}`)
  })
})

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

  it('resumes opencode via --session', () => {
    expect(resumeCommand('opencode', 'ses_a1b2c3')).toBe('opencode --session ses_a1b2c3')
  })

  it('resumes Copilot via its optional-value equals form', () => {
    expect(resumeCommand('copilot', 'abc-123')).toBe('copilot --resume=abc-123')
  })
  it('rejects an unsafe opencode session id', () => {
    expect(resumeCommand('opencode', 'x; rm -rf /')).toBeNull()
  })
})

/**
 * Grok's entry was read off the SHIPPED BINARY (`@xai-official/grok`, `grok --help`) rather than
 * from a README or from the shape of the agents beside it — `-r, --resume [<SESSION_ID>]`, the same
 * spelling claude and gemini use, which is why it shares their branch instead of getting its own.
 */
describe('resumeCommand — grok', () => {
  it('builds grok resume', () => {
    expect(resumeCommand('grok', 'abc-123')).toBe('grok --resume abc-123')
  })
})

/**
 * `base` is the user's launch-command override (settings.agentLaunchCommands — e.g. an
 * account-switching wrapper), threaded in from the renderer because this shared module cannot
 * read the settings store. It replaces the PROGRAM part only; each agent's resume grammar
 * (`--resume` / `resume` / `--session`) stays put after it.
 */
describe('resumeCommand — launch-command override (base)', () => {
  it('replaces the program part for the --resume family', () => {
    expect(resumeCommand('claude', 'abc-123', false, 'my-claude work')).toBe(
      'my-claude work --resume abc-123'
    )
    expect(resumeCommand('gemini', 'abc-123', false, 'gemini-wrap')).toBe(
      'gemini-wrap --resume abc-123'
    )
  })

  it('keeps codex’s subcommand and opencode’s flag spelling', () => {
    expect(resumeCommand('codex', 'abc-123', false, '/opt/bin/codex-work')).toBe(
      '/opt/bin/codex-work resume abc-123'
    )
    expect(resumeCommand('opencode', 'ses_a1', false, 'oc-wrap')).toBe('oc-wrap --session ses_a1')
  })

  // An explicit override is the user saying "launch it exactly like this" — substituting the
  // managed launcher back in would un-say it (see resumeCommand's doc).
  it('wins over codex’s shared-identity launcher', () => {
    expect(resumeCommand('codex', 'abc-123', true, '/opt/bin/codex-work')).toBe(
      '/opt/bin/codex-work resume abc-123'
    )
  })

  it('ignores a blank override — the bare command, byte-identical', () => {
    expect(resumeCommand('claude', 'abc-123', false, '   ')).toBe('claude --resume abc-123')
    expect(resumeCommand('claude', 'abc-123', false, undefined)).toBe('claude --resume abc-123')
  })

  // SAFE_SESSION_ID is the gate whatever the caller passes — the override customizes the
  // program, never the validation.
  it('still refuses an unsafe session id, override or not', () => {
    expect(resumeCommand('claude', 'a; rm -rf /', false, 'wrapper')).toBeNull()
    expect(resumeCommand('claude', '', false, 'wrapper')).toBeNull()
  })
})
