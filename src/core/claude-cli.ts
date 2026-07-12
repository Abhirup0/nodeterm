// Capability probe for the LOCAL Claude CLI. Today it answers exactly one question — does this
// CLI accept `--permission-mode auto`? (Claude Code >= 2.1.71; older CLIs exit 1 on the value, see
// AUTO_PERMISSION_MODE_MIN_VERSION) — but it is shaped as a caps bag so the next version-gated
// flag lands here instead of growing another probe.
//
// Lives in core (not main) so the Server Edition boots it through the same CorePlatform seam.
// The remote (SSH) CLI is probed separately on its own host — see SshProjectManager.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { supportsAutoPermissionMode } from '../shared/agents/config'
import { IPC } from '../shared/ipc'
import { UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps } from '../shared/types'
import { findInLoginPath } from './pty-manager'
import { platform } from './platform'

const execFileP = promisify(execFile)
const PROBE_TIMEOUT_MS = 5000

export { UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps }

/** Pure: `claude --version` output → caps. The impure probe below is just plumbing around it. */
export function claudeCliCapsFrom(versionOutput: string | null | undefined): ClaudeCliCaps {
  const version = versionOutput?.trim() || null
  return { version, autoPermissionMode: supportsAutoPermissionMode(version) }
}

let cached: Promise<ClaudeCliCaps> | null = null

async function probe(): Promise<ClaudeCliCaps> {
  try {
    // GUI apps don't inherit the shell PATH — resolve through the login shell like every other
    // CLI lookup in the app (pty-manager, commit-message).
    const bin = await findInLoginPath('claude')
    if (!bin) return UNKNOWN_CLAUDE_CLI_CAPS
    const { stdout } = await execFileP(bin, ['--version'], { timeout: PROBE_TIMEOUT_MS })
    return claudeCliCapsFrom(stdout)
  } catch {
    // Missing CLI, timeout, non-zero exit — all mean "unknown", which means "omit the flag".
    return UNKNOWN_CLAUDE_CLI_CAPS
  }
}

/**
 * The local Claude CLI's capabilities. Memoized for the process lifetime: `claude --version`
 * spawns a login shell + node, and the answer only changes when the user upgrades the CLI (which a
 * relaunch picks up). Never rejects.
 */
export function claudeCliCaps(): Promise<ClaudeCliCaps> {
  if (!cached) cached = probe()
  return cached
}

/** Wire the probe onto the platform's RPC surface (Electron ipcMain / server WS-RPC alike). */
export function registerClaudeCliIpc(): void {
  platform().handle(IPC.claudeCliCaps, () => claudeCliCaps())
}
