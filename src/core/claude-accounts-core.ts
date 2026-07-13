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
 * Jail predicate for a hook-reported LOCAL `transcript_path`: hook POSTs can arrive over the
 * remote reverse tunnel, so a forged POST must not make the app read an arbitrary local file.
 * Legitimate local transcripts live under exactly two roots:
 *   - the system default `~/.claude/projects`, and
 *   - a managed account's `{userData}/claude-accounts/<accountId>/projects`.
 * For the account root the `<accountId>` segment is validated with `ACCOUNT_ID_RE` (dots barred,
 * so `..` can never sneak in) and the very next segment must be `projects` — a prefix match on
 * `{userData}/claude-accounts` alone is NOT enough (it would accept `…/claude-accounts/x/.ssh`).
 * `abs` must already be resolved/normalized by the caller (e.g. `path.resolve(tp)`).
 */
export function isSafeLocalTranscriptPath(
  abs: string,
  homeDir: string,
  userDataPath: string
): boolean {
  const legacyRoot = path.join(homeDir, '.claude', 'projects')
  if (abs === legacyRoot || abs.startsWith(legacyRoot + path.sep)) return true
  const accountsRoot = path.join(userDataPath, 'claude-accounts')
  if (abs !== accountsRoot && !abs.startsWith(accountsRoot + path.sep)) return false
  // Relative to the accounts root: expect `<accountId>/projects[/…]`. Because `abs` is normalized
  // and confirmed under `accountsRoot`, `path.relative` yields no leading `..`.
  const segs = path.relative(accountsRoot, abs).split(path.sep)
  return segs.length >= 2 && ACCOUNT_ID_RE.test(segs[0]) && segs[1] === 'projects'
}

/**
 * Remote analogue of `isSafeLocalTranscriptPath`, for the transcript_path a REMOTE node's hooks
 * POST over the reverse tunnel. Same threat (a forged POST must not make the app read an arbitrary
 * file) and the same two-root shape, but resolved with POSIX semantics (remote hosts are POSIX)
 * and rooted at the project's remote `$HOME`:
 *   - the system default `<remoteHome>/.claude/projects`, and
 *   - a managed REMOTE account's `<remoteHome>/.nodeterm/claude-accounts/<accountId>/projects`
 *     (see `remoteAccountConfigDir`) — jailing to the default root alone dropped every payload
 *     for a remote account, which silently killed the session-name sync, the context meter and
 *     the subagent cards on those nodes.
 * `remoteHome` unknown ⇒ false (fail closed: without a root there is nothing to jail against).
 */
export function isSafeRemoteTranscriptPath(abs: string, remoteHome: string | undefined): boolean {
  if (!abs || !remoteHome) return false
  const p = path.posix.resolve(abs)
  const legacyRoot = path.posix.join(remoteHome, '.claude', 'projects')
  if (p === legacyRoot || p.startsWith(legacyRoot + '/')) return true
  const accountsRoot = path.posix.join(remoteHome, '.nodeterm', 'claude-accounts')
  if (!p.startsWith(accountsRoot + '/')) return false
  // Relative to the accounts root: expect `<accountId>/projects[/…]`. `p` is normalized and
  // confirmed under `accountsRoot`, so `relative` yields no leading `..`.
  const segs = path.posix.relative(accountsRoot, p).split('/')
  return segs.length >= 2 && ACCOUNT_ID_RE.test(segs[0]) && segs[1] === 'projects'
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
