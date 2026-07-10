import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Auth } from './auth'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-auth-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.useRealTimers() })

describe('Auth', () => {
  it('is unconfigured until a password is set; then verifies only the right one', () => {
    const a = new Auth(dir)
    expect(a.isConfigured()).toBe(false)
    expect(a.verifyPassword('anything')).toBe(false)
    a.setPassword('correct horse')
    expect(a.isConfigured()).toBe(true)
    expect(a.verifyPassword('correct horse')).toBe(true)
    expect(a.verifyPassword('wrong')).toBe(false)
    // survives process restart (re-read from disk)
    expect(new Auth(dir).verifyPassword('correct horse')).toBe(true)
  })

  it('setup token is single-use and timing-safe-compared', () => {
    const a = new Auth(dir)
    const tok = a.setupToken()
    expect(a.setupToken()).toBe(tok) // stable within process
    expect(a.consumeSetupToken('wrong')).toBe(false)
    expect(a.consumeSetupToken(tok)).toBe(true)
    expect(a.consumeSetupToken(tok)).toBe(false) // consumed
  })

  it('sessions persist, validate, expire and revoke', () => {
    vi.useFakeTimers()
    const a = new Auth(dir)
    const t = a.createSession()
    expect(a.validateSession(t)).toBe(true)
    expect(a.validateSession('nope')).toBe(false)
    expect(a.validateSession(undefined)).toBe(false)
    expect(new Auth(dir).validateSession(t)).toBe(true) // persisted
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000)
    expect(a.validateSession(t)).toBe(false) // expired
    const t2 = a.createSession()
    a.revokeAll()
    expect(a.validateSession(t2)).toBe(false)
  })

  it('locks out after 5 consecutive failures for 60s; success resets', () => {
    vi.useFakeTimers()
    const a = new Auth(dir)
    for (let i = 0; i < 5; i++) { expect(a.loginAllowed()).toBe(true); a.recordLoginFailure() }
    expect(a.loginAllowed()).toBe(false)
    vi.advanceTimersByTime(61_000)
    expect(a.loginAllowed()).toBe(true)
    a.recordLoginFailure(); a.recordLoginSuccess()
    for (let i = 0; i < 5; i++) { expect(a.loginAllowed()).toBe(true); a.recordLoginFailure() }
    expect(a.loginAllowed()).toBe(false)
  })
})
