// Impure lifecycle for managed Claude accounts: config-dir creation/deletion, login
// capture (poll .claude.json), CLI version check, hook install. The account LIST lives in
// settings.json (renderer-owned via useSettings); this module only owns the filesystem.
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import { isSupportedClaudeVersion, parseLoginCapture } from '../core/claude-accounts-core'
import { claudeConfigDirFor } from '../core/claude-config-dir'
import { installClaudeHooksInto, ensureClaudeFullscreenTuiInto } from '../core/agents/hooks/claude'
import { installCanvasSkillInto } from './canvas-control'
import { findInLoginPath } from '../core/pty-manager'
import type { SshProjectManager } from './remote-ssh/ssh-project'

const execFileP = promisify(execFile)
const LOGIN_POLL_MS = 2000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

// Re-exported for this module's other consumers (claude-usage.ts) so their import path is
// unchanged; the implementation now lives in core (../core/claude-config-dir).
export { claudeConfigDirFor } from '../core/claude-config-dir'

/**
 * Optional per-call SSH context. When `projectId` is present AND that project has a live
 * ControlMaster, the account is a REMOTE one: its config dir + login capture + removal happen on the
 * host over ssh instead of on the local filesystem. The renderer passes it only for accounts scoped
 * to an SSH project (`ClaudeAccount.host`); local accounts omit it entirely (unchanged behavior).
 */
interface AccountCtx {
  projectId?: string
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

/**
 * @param getSshManager Lazily resolves the SSH project manager (created after this init in index.ts).
 * Returns undefined when SSH isn't wired — every remote path then falls back to local behavior.
 */
export function initClaudeAccounts(getSshManager?: () => SshProjectManager | undefined): void {
  // Resolve the live remote manager for a context, or null when the context is local / not connected.
  const remoteFor = (ctx?: AccountCtx): { mgr: SshProjectManager; projectId: string } | null => {
    const projectId = ctx?.projectId
    const mgr = getSshManager?.()
    return projectId && mgr ? { mgr, projectId } : null
  }

  ipcMain.handle(IPC.claudeAccountsAdd, async (_e, ctx?: AccountCtx) => {
    const id = randomUUID()
    const remote = remoteFor(ctx)
    if (remote) {
      // REMOTE account: create the config dir + install the status hook on the host. No local dir
      // and no local hook install — the session runs entirely on the remote host.
      const res = await remote.mgr.remoteAccountAdd(remote.projectId, id)
      // Null means the project wasn't connected / mkdir failed: still return the id so the renderer
      // can show the pending row; the login node will surface the connection error itself.
      return { id, configDir: res?.configDir ?? '', versionSupported: res?.versionSupported ?? true }
    }
    const configDir = claudeConfigDirFor(id)
    await fs.mkdir(configDir, { recursive: true })
    // Install the managed hook + canvas skill up front so the very first session in this
    // account already reports status (badges/notifications/subagent viz) and can control
    // the canvas (Claude resolves skills relative to CLAUDE_CONFIG_DIR, not ~/.claude).
    installClaudeHooksInto(configDir)
    installCanvasSkillInto(configDir)
    // Ensure fullscreen TUI in the new account dir (write-if-absent, version-gated). Best-effort,
    // off the response path — the memoized probe + write both fail open.
    void ensureClaudeFullscreenTuiInto(configDir)
    const versionSupported = await checkClaudeVersion()
    return { id, configDir, versionSupported }
  })

  ipcMain.handle(IPC.claudeAccountsWaitLogin, async (_e, id: string, ctx?: AccountCtx) => {
    const remote = remoteFor(ctx)
    // Local path: `claudeConfigDirFor` also validates the id shape (rejects traversal).
    const configDir = remote ? null : claudeConfigDirFor(id)
    const w = { cancelled: false }
    waiters.set(id, w)
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    try {
      while (!w.cancelled && Date.now() < deadline) {
        try {
          const raw = remote
            ? await remote.mgr.remoteAccountReadLogin(remote.projectId, id)
            : await fs.readFile(path.join(configDir as string, '.claude.json'), 'utf-8')
          const captured = raw ? parseLoginCapture(raw) : null
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

  ipcMain.handle(IPC.claudeAccountsRemove, async (_e, id: string, ctx?: AccountCtx) => {
    const remote = remoteFor(ctx)
    if (remote) {
      // Best-effort remote cleanup; if the project isn't connected the manager no-ops and the
      // renderer still drops the account from its list (the dir is orphaned, harmless).
      await remote.mgr.remoteAccountRemove(remote.projectId, id)
      return
    }
    const configDir = claudeConfigDirFor(id) // id validation prevents traversal
    await fs.rm(configDir, { recursive: true, force: true })
  })
}
