/**
 * Issue #313 — the managed-Claude-account LIFECYCLE lives in core, so both shells serve it.
 *
 * Every one of these cases drives the shipped registration through the platform seam
 * (`fakePlatform().handlers[...]`), i.e. exactly what `ipcMain.handle` / the server's WS dispatch
 * invoke. Registering with NO deps is the Server Edition's own configuration: no canvas skill
 * (canvas control is not wired there) and no SSH manager, so a ctx carrying a projectId must still
 * take the local path.
 *
 * MUTATION: drop the `installSkill` call, or let `remoteFor` treat a projectId alone as remote →
 * the skill case and the local-fallback case redden.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { registerClaudeAccountsIpc, installHooksIntoLocalAccounts } from './claude-accounts-service'
import { accountConfigDir } from './claude-accounts-core'

// The hook + TUI writers are exercised by their own suites; here they only have to be OBSERVED,
// and a real write would touch the account dir this file then asserts about.
const installed: string[] = []
const tui: string[] = []
vi.mock('./agents/hooks/claude', () => ({
  installClaudeHooksInto: (dir: string) => {
    installed.push(dir)
  },
  ensureClaudeFullscreenTuiInto: async (dir: string) => {
    tui.push(dir)
  }
}))

let fake: FakePlatform
let userDataDir: string

const call = (channel: string, ...args: unknown[]): Promise<any> =>
  Promise.resolve(fake.handlers[channel](...args))

beforeEach(() => {
  installed.length = 0
  tui.length = 0
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nt-accounts-'))
  fake = fakePlatform({ userDataDir })
  initPlatform(fake)
})
afterEach(() => {
  resetPlatformForTests()
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('registerClaudeAccountsIpc — the four channels', () => {
  it('registers exactly the four claude-accounts channels', () => {
    registerClaudeAccountsIpc()
    expect(Object.keys(fake.handlers).sort()).toEqual(
      [
        IPC.claudeAccountsAdd,
        IPC.claudeAccountsCancelWait,
        IPC.claudeAccountsRemove,
        IPC.claudeAccountsWaitLogin
      ].sort()
    )
  })

  it('add() creates the config dir under userData, installs the hook and returns the id', async () => {
    const skilled: string[] = []
    registerClaudeAccountsIpc({ installSkill: (d) => skilled.push(d) })
    const res = await call(IPC.claudeAccountsAdd)
    expect(res.id).toMatch(/^[A-Za-z0-9-]+$/)
    expect(res.configDir).toBe(accountConfigDir(userDataDir, res.id))
    expect(existsSync(res.configDir)).toBe(true)
    expect(installed).toEqual([res.configDir])
    expect(skilled).toEqual([res.configDir])
    expect(tui).toEqual([res.configDir])
  })

  it('add() without an installSkill dep (the Server Edition) writes no skill', async () => {
    registerClaudeAccountsIpc()
    const res = await call(IPC.claudeAccountsAdd)
    expect(existsSync(res.configDir)).toBe(true)
    expect(installed).toEqual([res.configDir])
  })

  it('waitLogin resolves once .claude.json carries an oauthAccount email', async () => {
    registerClaudeAccountsIpc({ pollMs: 5 })
    const { id, configDir } = await call(IPC.claudeAccountsAdd)
    const pending = call(IPC.claudeAccountsWaitLogin, id)
    setTimeout(() => {
      writeFileSync(
        path.join(configDir, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: 'a@b.com' } })
      )
    }, 20)
    await expect(pending).resolves.toEqual({ email: 'a@b.com' })
  })

  it('cancelWaitLogin makes an in-flight wait resolve null', async () => {
    registerClaudeAccountsIpc({ pollMs: 5 })
    const { id } = await call(IPC.claudeAccountsAdd)
    const pending = call(IPC.claudeAccountsWaitLogin, id)
    await new Promise((r) => setTimeout(r, 20))
    await call(IPC.claudeAccountsCancelWait, id)
    await expect(pending).resolves.toBeNull()
  })

  it('remove() deletes the account dir', async () => {
    registerClaudeAccountsIpc()
    const { id, configDir } = await call(IPC.claudeAccountsAdd)
    writeFileSync(path.join(configDir, '.credentials.json'), '{}')
    await call(IPC.claudeAccountsRemove, id)
    expect(existsSync(configDir)).toBe(false)
  })

  it('a traversing id is refused, not resolved outside the accounts root', async () => {
    registerClaudeAccountsIpc({ pollMs: 5 })
    await expect(call(IPC.claudeAccountsRemove, '../x')).rejects.toThrow(/invalid account id/)
    await expect(call(IPC.claudeAccountsWaitLogin, '../x')).rejects.toThrow(/invalid account id/)
  })
})

describe('the remote leg is resolved lazily, and its absence falls back to LOCAL', () => {
  it('a ctx with a projectId takes the remote leg when one is wired', async () => {
    const calls: string[] = []
    registerClaudeAccountsIpc({
      pollMs: 5,
      remote: () => ({
        add: async (projectId, id) => {
          calls.push(`add:${projectId}:${id}`)
          return { configDir: `~/.nodeterm/claude-accounts/${id}`, versionSupported: true }
        },
        readLogin: async () => JSON.stringify({ oauthAccount: { email: 'r@h.com' } }),
        remove: async (projectId, id) => {
          calls.push(`rm:${projectId}:${id}`)
        }
      })
    })
    const res = await call(IPC.claudeAccountsAdd, { projectId: 'p1' })
    expect(res.configDir).toBe(`~/.nodeterm/claude-accounts/${res.id}`)
    // Nothing local was created or installed for a remote account.
    expect(existsSync(accountConfigDir(userDataDir, res.id))).toBe(false)
    expect(installed).toEqual([])
    await expect(call(IPC.claudeAccountsWaitLogin, res.id, { projectId: 'p1' })).resolves.toEqual({
      email: 'r@h.com'
    })
    await call(IPC.claudeAccountsRemove, res.id, { projectId: 'p1' })
    expect(calls).toEqual([`add:p1:${res.id}`, `rm:p1:${res.id}`])
  })

  it('a ctx with a projectId but NO wired remote takes the local path (Server Edition)', async () => {
    registerClaudeAccountsIpc({ remote: () => undefined })
    const res = await call(IPC.claudeAccountsAdd, { projectId: 'p1' })
    expect(res.configDir).toBe(accountConfigDir(userDataDir, res.id))
    expect(existsSync(res.configDir)).toBe(true)
  })
})

describe('installHooksIntoLocalAccounts', () => {
  it('installs into every LOCAL account dir and skips host-scoped ones', () => {
    const extra: string[] = []
    installHooksIntoLocalAccounts(
      [{ id: 'aaa' }, { id: 'bbb', host: 'user@example' }, { id: 'ccc' }],
      (d) => extra.push(d)
    )
    const dirs = ['aaa', 'ccc'].map((id) => accountConfigDir(userDataDir, id))
    expect(installed).toEqual(dirs)
    expect(extra).toEqual(dirs)
    expect(tui).toEqual(dirs)
  })

  it('one failing account never stops the rest (boot must not be blocked)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mkdirSync(path.join(userDataDir, 'claude-accounts'), { recursive: true })
    installHooksIntoLocalAccounts([{ id: 'aaa' }, { id: '../evil' }, { id: 'ccc' }])
    expect(installed).toEqual(
      ['aaa', 'ccc'].map((id) => accountConfigDir(userDataDir, id))
    )
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
