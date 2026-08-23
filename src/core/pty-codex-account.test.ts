// Property 4 (S6 §5) / Decision 2: an EXPLICITLY selected managed Codex account whose home is
// missing REFUSES — it never falls back to the system home. This pins the fail-closed spawn scope
// at the model layer (`resolveCodexSessionScope`), where the later pty-manager PR consumes it. The
// PR-1 model ships inert, so this tests the resolver against a REAL temp filesystem rather than a
// full PtyManager spawn (nothing spawns against the model yet).
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  codexAccountHome,
  isCodexScopeRefusal,
  resolveCodexSessionScope
} from './codex-accounts-core'

describe('Codex spawn scope resolves fail-closed', () => {
  let userDataDir: string

  beforeEach(() => {
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-scope-'))
  })
  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('fails closed without spawning when an explicitly selected account home is missing', () => {
    // The short home is deliberately NOT created.
    const scope = resolveCodexSessionScope(userDataDir, 'account-a', existsSync)
    expect(isCodexScopeRefusal(scope)).toBe(true)
    expect(scope).toEqual({ unavailable: 'codex-account' })
    // Decision 2: the refusal must NOT be the system home under any key.
    expect((scope as { CODEX_HOME?: string }).CODEX_HOME).toBeUndefined()
  })

  it('spawns against only the selected managed home once it exists', () => {
    const home = codexAccountHome(userDataDir, 'account-a')
    mkdirSync(home, { recursive: true })
    const scope = resolveCodexSessionScope(userDataDir, 'account-a', existsSync)
    expect(isCodexScopeRefusal(scope)).toBe(false)
    expect(scope).toEqual({ CODEX_HOME: home, NODETERM_CODEX_ACCOUNT_ID: 'account-a' })
  })

  it('uses explicit system scope instead of an inherited managed scope', () => {
    // No account id ⇒ system scope, and it ALWAYS resolves (never refuses), explicitly clearing
    // any managed NODETERM_CODEX_ACCOUNT_ID a parent process leaked in.
    const scope = resolveCodexSessionScope(userDataDir, undefined, existsSync)
    expect(isCodexScopeRefusal(scope)).toBe(false)
    expect(scope).toMatchObject({ NODETERM_CODEX_ACCOUNT_ID: '' })
    expect(path.isAbsolute((scope as { CODEX_HOME: string }).CODEX_HOME)).toBe(true)
  })

  it('refuses an unsafe explicit account id before touching the filesystem', () => {
    expect(() => resolveCodexSessionScope(userDataDir, '../escape', existsSync)).toThrow(
      'Invalid Codex account id'
    )
  })
})
