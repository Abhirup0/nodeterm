// Impure lifecycle for managed Claude accounts: config-dir creation/deletion, login capture
// (poll .claude.json), CLI version check, per-account hook install. The account LIST lives in
// settings.json (renderer-owned via useSettings); this module only owns the filesystem.
//
// Lives in core so BOTH shells serve it. Before this the four channels were registered only by
// src/main, so the Server Edition's bridge answered E_UNSUPPORTED for every one of them: a
// browser-only deployment could select a managed account (env injection, transcript readers,
// usage and the pickers are all core already) but could never CREATE, log into or remove one
// (issue #313).
import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../shared/ipc'
import { isSupportedClaudeVersion, parseLoginCapture } from './claude-accounts-core'
import { claudeConfigDirFor } from './claude-config-dir'
import { installClaudeHooksInto, ensureClaudeFullscreenTuiInto } from './agents/hooks/claude'
import { findInLoginPath } from './pty-manager'
import { platform } from './platform'

const execFileP = promisify(execFile)
const LOGIN_POLL_MS = 2000
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Optional per-call SSH context. When `projectId` is present AND that project has a live
 * ControlMaster, the account is a REMOTE one: its config dir + login capture + removal happen on the
 * host over ssh instead of on the local filesystem. The renderer passes it only for accounts scoped
 * to an SSH project (`ClaudeAccount.host`); local accounts omit it entirely (unchanged behavior).
 */
export interface AccountCtx {
  projectId?: string
}

/** The three remote legs, as the shell implements them (desktop: SshProjectManager). */
export interface ClaudeAccountsRemote {
  add(
    projectId: string,
    id: string
  ): Promise<{ configDir: string; versionSupported: boolean } | null>
  readLogin(projectId: string, id: string): Promise<string | null>
  remove(projectId: string, id: string): Promise<void>
}

export interface ClaudeAccountsDeps {
  /**
   * Install the canvas-control skill into a freshly created account dir. Claude Code resolves
   * skills relative to CLAUDE_CONFIG_DIR, so a managed account needs its own copy. DESKTOP ONLY:
   * canvas control is not wired on the Server Edition at all (its hook server answers
   * `control unavailable` by name), so there is nothing for a skill file to reach there.
   */
  installSkill?: (configDir: string) => void
  /**
   * Resolves the live remote legs, or undefined when SSH is not wired / not yet created. A THUNK
   * rather than a plain object because that is the fact the local fallback turns on: desktop
   * creates its SshProjectManager after this registration, and an `AccountCtx` carrying a
   * projectId while no manager exists must degrade to the LOCAL path (pre-existing behavior).
   * The Server Edition passes none, so every call takes that same local path.
   */
  remote?: () => ClaudeAccountsRemote | undefined
  /** Login poll interval. Injectable so tests need not wait out the 2 s production cadence. */
  pollMs?: number
}

const waiters = new Map<string, { cancelled: boolean }>()

async function checkClaudeVersion(): Promise<boolean> {
  // The < 2.1 warning is about the shared macOS Keychain service; on Linux/Windows
  // credentials are files inside each config dir, so no version collides.
  if (process.platform !== 'darwin') return true
  try {
    const claude = await findInLoginPath('claude')
    if (!claude) return false
    const { stdout } = await execFileP(claude, ['--version'], { timeout: 5000 })
    return isSupportedClaudeVersion(stdout.trim())
  } catch {
    return false
  }
}

/** Register the four `claude-accounts:*` channels on the core platform seam. */
export function registerClaudeAccountsIpc(deps: ClaudeAccountsDeps = {}): void {
  const pollMs = deps.pollMs ?? LOGIN_POLL_MS
  // Resolve the live remote legs for a context, or null when the context is local / not connected.
  const remoteFor = (ctx?: AccountCtx): { r: ClaudeAccountsRemote; projectId: string } | null => {
    const projectId = ctx?.projectId
    const r = deps.remote?.()
    return projectId && r ? { r, projectId } : null
  }

  platform().handle(IPC.claudeAccountsAdd, async (ctx?: AccountCtx) => {
    const id = randomUUID()
    const remote = remoteFor(ctx)
    if (remote) {
      // REMOTE account: create the config dir + install the status hook on the host. No local dir
      // and no local hook install — the session runs entirely on the remote host.
      const res = await remote.r.add(remote.projectId, id)
      // Null means the project wasn't connected / mkdir failed: still return the id so the renderer
      // can show the pending row; the login node will surface the connection error itself.
      return { id, configDir: res?.configDir ?? '', versionSupported: res?.versionSupported ?? true }
    }
    const configDir = claudeConfigDirFor(id)
    await fs.mkdir(configDir, { recursive: true })
    // Install the managed hook (+ the canvas skill where the shell has one) up front so the very
    // first session in this account already reports status (badges/notifications/subagent viz)
    // and can control the canvas (Claude resolves both relative to CLAUDE_CONFIG_DIR, not ~/.claude).
    installClaudeHooksInto(configDir)
    deps.installSkill?.(configDir)
    // Ensure fullscreen TUI in the new account dir (write-if-absent, version-gated). Best-effort,
    // off the response path — the memoized probe + write both fail open.
    void ensureClaudeFullscreenTuiInto(configDir)
    const versionSupported = await checkClaudeVersion()
    return { id, configDir, versionSupported }
  })

  platform().handle(IPC.claudeAccountsWaitLogin, async (id: string, ctx?: AccountCtx) => {
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
            ? await remote.r.readLogin(remote.projectId, id)
            : await fs.readFile(path.join(configDir as string, '.claude.json'), 'utf-8')
          const captured = raw ? parseLoginCapture(raw) : null
          if (captured) return captured
        } catch {
          // not written yet — keep polling
        }
        await new Promise((r) => setTimeout(r, pollMs))
      }
      return null
    } finally {
      waiters.delete(id)
    }
  })

  platform().handle(IPC.claudeAccountsCancelWait, (id: string) => {
    const w = waiters.get(id)
    if (w) w.cancelled = true
  })

  platform().handle(IPC.claudeAccountsRemove, async (id: string, ctx?: AccountCtx) => {
    const remote = remoteFor(ctx)
    if (remote) {
      // Best-effort remote cleanup; if the project isn't connected the manager no-ops and the
      // renderer still drops the account from its list (the dir is orphaned, harmless).
      await remote.r.remove(remote.projectId, id)
      return
    }
    const configDir = claudeConfigDirFor(id) // id validation prevents traversal
    await fs.rm(configDir, { recursive: true, force: true })
  })
}

/**
 * Install the managed hook + fullscreen-TUI setting into every LOCAL managed account dir. Managed
 * accounts each carry their own settings.json (Claude Code resolves it relative to
 * CLAUDE_CONFIG_DIR), so an app update's new hook version must reach them too. Best-effort per
 * account: one failing account must never block launch (matches installManagedAgentHooks'
 * fail-open). `extra` is the shell's per-account addition — desktop installs the canvas skill.
 */
export function installHooksIntoLocalAccounts(
  accounts: readonly { id: string; host?: string }[],
  extra?: (configDir: string) => void
): void {
  for (const acct of accounts) {
    if (acct.host) continue // remote accounts live on another host; nothing to install locally
    try {
      const configDir = claudeConfigDirFor(acct.id)
      installClaudeHooksInto(configDir)
      extra?.(configDir)
      // Off the critical path: it awaits the memoized CLI probe, then writes fail-open. (The
      // system ~/.claude is handled by installManagedAgentHooks, which covers both shells.)
      void ensureClaudeFullscreenTuiInto(configDir)
    } catch (e) {
      console.warn(`[agent-hooks] account ${acct.id} hook install failed`, e)
    }
  }
}
