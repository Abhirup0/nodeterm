import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { ServerPlatform } from '../platform-server'
import { registerCoreHandlers } from './index'
import { IPC } from '../../shared/ipc'
import { DEFAULT_SETTINGS, type GitStatus } from '../../shared/types'
import { initPlatform, resetPlatformForTests } from '../../core/platform'

let repo: string, platform: ServerPlatform, ui: number
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-git-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n')
  platform = new ServerPlatform({ userDataDir: repo, appVersion: '0' })
  // GitService.registerIpc() registers via the global core platform(), so wire it here
  // (boot does this via initPlatform() before registerCoreHandlers — mirror that order).
  initPlatform(platform)
  registerCoreHandlers(platform, { getSettings: () => DEFAULT_SETTINGS })
  ui = platform.attach({ sendText: () => {}, sendBinary: () => {} })
})
afterEach(() => {
  resetPlatformForTests()
  fs.rmSync(repo, { recursive: true, force: true })
})

async function call(method: string, ...args: unknown[]) {
  const res = await platform.dispatch(ui, { t: 'req', id: 1, method, args })
  if (!res.ok) throw new Error(res.error.code)
  return res.result
}

describe('registerCoreHandlers (git)', () => {
  it('git.status reports the modified file', async () => {
    const status = (await call(IPC.gitStatus, repo)) as GitStatus
    // a.txt is modified in the working tree (unstaged) → `changes`.
    expect([...status.staged, ...status.changes].some((f) => f.path === 'a.txt')).toBe(true)
  })
  it('git.showFile returns HEAD content', async () => {
    // git-service's runner trims trailing whitespace from git output.
    expect(await call(IPC.gitShowFile, repo, 'HEAD', 'a.txt')).toBe('one')
  })
  it('git.diff returns a unified diff of the working change', async () => {
    const diff = (await call(IPC.gitDiff, repo, 'a.txt', false, false)) as string
    expect(diff).toContain('-one')
    expect(diff).toContain('+two')
  })
  it('fs handlers are registered too (delegated)', async () => {
    expect(await call(IPC.fsRead, path.join(repo, 'a.txt'))).toBe('two\n')
  })
  it("app:user-data-dir answers the server's real data dir (never '')", async () => {
    // The worktree dialog derives its default path from this: an empty answer would suggest
    // `/worktrees/…` at the filesystem ROOT, which the (often root-run) server would create.
    expect(await call(IPC.appUserDataDir)).toBe(repo)
  })
})
