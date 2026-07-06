// Pure logic for managed Claude accounts (config-dir isolation). No fs/electron imports —
// everything here is unit-tested; the impure lifecycle lives in claude-accounts.ts.
import { createHash } from 'crypto'
import path from 'path'

/** Shape of a valid account id (uuid / opaque token). Shared by every path builder so a bad id
 *  can never traverse out of the accounts root — locally OR on a remote host over ssh. */
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]+$/
function assertAccountId(accountId: string): void {
  if (!ACCOUNT_ID_RE.test(accountId)) {
    throw new Error(`invalid account id: ${JSON.stringify(accountId)}`)
  }
}

/** Root-relative config dir for a managed account. Rejects ids that could escape the root. */
export function accountConfigDir(userDataPath: string, accountId: string): string {
  assertAccountId(accountId)
  return path.join(userDataPath, 'claude-accounts', accountId)
}

/**
 * Remote (SSH) config dir for a managed account, relative to the remote `$HOME` as a `~`-prefixed
 * path (`~/.nodeterm/claude-accounts/<id>`). Used for ssh EXEC args (mkdir / cat / rm), where
 * `quoteRemotePath` leaves the leading `~` unquoted so the remote shell expands it. NOT for tmux
 * `-e` (tmux does not shell-expand values — use `remoteAccountConfigDirAbs` there). Id-validated so
 * a hostile id can never escape `~/.nodeterm/claude-accounts/` on the remote host.
 */
export function remoteAccountConfigDir(accountId: string): string {
  assertAccountId(accountId)
  return `~/.nodeterm/claude-accounts/${accountId}`
}

/**
 * Absolute remote config dir for a managed account, given the resolved remote `$HOME`. Needed for
 * the tmux `-e CLAUDE_CONFIG_DIR=…` env: tmux copies the value literally (no `$HOME`/`~` expansion),
 * so the path must already be absolute. `remoteHome` is the connection's cached `$HOME`.
 */
export function remoteAccountConfigDirAbs(remoteHome: string, accountId: string): string {
  assertAccountId(accountId)
  return `${remoteHome.replace(/\/+$/, '')}/.nodeterm/claude-accounts/${accountId}`
}

/**
 * Transcript root for a session lookup: an account's `projects` dir under its config dir, or
 * the system default `~/.claude/projects` when no account. Pure path math (no fs) — the impure
 * wrapper in transcript-reader.ts feeds `os.homedir()` / `app.getPath('userData')`. Reuses
 * `accountConfigDir`'s id validation so a bad account id can never escape the accounts root.
 */
export function transcriptRootFor(
  homeDir: string,
  userDataPath: string | null,
  accountId?: string
): string {
  return accountId
    ? path.join(accountConfigDir(userDataPath ?? '', accountId), 'projects')
    : path.join(homeDir, '.claude', 'projects')
}

/**
 * Claude Code ≥ 2.1 scopes its macOS Keychain service name per config dir:
 * 'Claude Code-credentials-' + first 8 hex chars of sha256(CLAUDE_CONFIG_DIR).
 * (Learned from REF's claude-accounts/keychain.ts — undocumented CLI behavior.)
 */
export function claudeKeychainService(configDir: string): string {
  const suffix = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `Claude Code-credentials-${suffix}`
}

/**
 * Where the usage indicator looks for a Claude OAuth token + identity, per account. With a
 * `configDir` (managed account) the scoped Keychain service comes first — Claude Code ≥ 2.1
 * writes there — with the legacy unscoped services as fallback for older CLIs; the file +
 * identity live under that config dir. Without a `configDir` (system account) it's exactly the
 * legacy layout: unscoped services + `~/.claude`. Pure so it's unit-tested; the impure keychain
 * / fs reads live in claude-usage.ts.
 */
export function usageCredsPaths(
  homeDir: string,
  configDir?: string
): { services: string[]; credsFile: string; identityFile: string } {
  if (configDir) {
    return {
      services: [claudeKeychainService(configDir), 'Claude Code-credentials', 'claudeAiOauth'],
      credsFile: path.join(configDir, '.credentials.json'),
      identityFile: path.join(configDir, '.claude.json')
    }
  }
  return {
    services: ['Claude Code-credentials', 'claudeAiOauth'],
    credsFile: path.join(homeDir, '.claude', '.credentials.json'),
    identityFile: path.join(homeDir, '.claude.json')
  }
}

/** Env vars that would silently shadow the selected account's OAuth login. Stripped at spawn. */
export const AUTH_ENV_STRIP = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN'
] as const

/** tmux `-e` pair injecting the account config dir (shared server → per-session env). */
export function accountTmuxEnvArgs(configDir: string): string[] {
  return ['-e', `CLAUDE_CONFIG_DIR=${configDir}`]
}

/** Parse `{configDir}/.claude.json` for a completed login's identity. Null until login lands. */
export function parseLoginCapture(rawClaudeJson: string): { email: string } | null {
  try {
    const j = JSON.parse(rawClaudeJson) as Record<string, any>
    const acct = j.oauthAccount as Record<string, any> | undefined
    const email =
      (acct && typeof acct.emailAddress === 'string' && acct.emailAddress) ||
      (acct && typeof acct.email === 'string' && acct.email) ||
      null
    return email ? { email } : null
  } catch {
    return null
  }
}

/** Claude Code < 2.1 uses one unscoped Keychain service for every config dir → accounts collide. */
export function isSupportedClaudeVersion(versionOutput: string): boolean {
  const m = versionOutput.match(/(\d+)\.(\d+)\./)
  if (!m) return false
  const [major, minor] = [Number(m[1]), Number(m[2])]
  return major > 2 || (major === 2 && minor >= 1)
}
