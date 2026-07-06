// Impure lifecycle for managed Claude accounts: config-dir creation/deletion, login
// capture (poll .claude.json), CLI version check, hook install. The account LIST lives in
// settings.json (renderer-owned via useSettings); this module only owns the filesystem.
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { app, ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import { accountConfigDir, isSupportedClaudeVersion, parseLoginCapture } from './claude-accounts-core'
import { installClaudeHooksInto } from './agents/hooks/claude'
import { findInLoginPath } from './pty-manager'

const execFileP = promisify(execFile)
const LOGIN_POLL_MS = 2000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export function claudeConfigDirFor(accountId: string): string {
  return accountConfigDir(app.getPath('userData'), accountId)
}

const waiters = new Map<string, { cancelled: boolean }>()

async function checkClaudeVersion(): Promise<boolean> {
  try {
    const claude = await findInLoginPath('claude')
    if (!claude) return false
    const { stdout } = await execFileP(claude, ['--version'], { timeout: 5000 })
    return isSupportedClaudeVersion(stdout.trim())
  } catch {
    return false
  }
}

export function initClaudeAccounts(): void {
  ipcMain.handle(IPC.claudeAccountsAdd, async () => {
    const id = randomUUID()
    const configDir = claudeConfigDirFor(id)
    await fs.mkdir(configDir, { recursive: true })
    // Install the managed hook up front so the very first session in this account
    // already reports status (badges/notifications/subagent viz).
    installClaudeHooksInto(configDir)
    const versionSupported = await checkClaudeVersion()
    return { id, configDir, versionSupported }
  })

  ipcMain.handle(IPC.claudeAccountsWaitLogin, async (_e, id: string) => {
    const configDir = claudeConfigDirFor(id) // validates the id shape
    const w = { cancelled: false }
    waiters.set(id, w)
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    try {
      while (!w.cancelled && Date.now() < deadline) {
        try {
          const raw = await fs.readFile(path.join(configDir, '.claude.json'), 'utf-8')
          const captured = parseLoginCapture(raw)
          if (captured) return captured
        } catch {
          // not written yet — keep polling
        }
        await new Promise((r) => setTimeout(r, LOGIN_POLL_MS))
      }
      return null
    } finally {
      waiters.delete(id)
    }
  })

  ipcMain.handle(IPC.claudeAccountsCancelWait, (_e, id: string) => {
    const w = waiters.get(id)
    if (w) w.cancelled = true
  })

  ipcMain.handle(IPC.claudeAccountsRemove, async (_e, id: string) => {
    const configDir = claudeConfigDirFor(id) // id validation prevents traversal
    await fs.rm(configDir, { recursive: true, force: true })
  })
}
