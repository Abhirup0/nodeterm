// Pure model + on-disk layout for machine-scoped managed Codex accounts. Mirrors
// `claude-accounts-core.ts` (multiple managed logins), with `CODEX_HOME` in place of
// `CLAUDE_CONFIG_DIR` and OpenAI/Codex key vars in the auth-env strip. Only `crypto`/`fs`/`os`/
// `path` — no electron, no `../main/*` — so it arms on headless Server Edition too. The impure
// account LIST + login lifecycle land in a later PR's `src/main/codex-accounts.ts`; the
// `platform()` seam for `userDataDir` lives in `codex-config-dir.ts`.
//
// Ships INERT (nothing spawns against it yet) but fully tested. Based on @Corvin's
// `codex-accounts-core.ts` in PR #112, re-sliced to the S6 PR-1 model layer.
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, renameSync } from 'fs'
import os from 'os'
import path from 'path'
import { ACCOUNT_ID_RE, isSafeAccountId } from '../shared/codex-account'

export { ACCOUNT_ID_RE, isSafeAccountId } from '../shared/codex-account'

/**
 * Throw on any id that could escape the accounts root — locally OR on a remote host over ssh.
 * Account ids reach the filesystem as directory / socket / scope / mapping-file components and
 * come from attacker-controlled `settings.json` / `project.json`, so this is the supply-chain
 * guard: `''`, `.`, `..`, `a/b`, `/absolute`, and whitespace ids are all refused at the door.
 */
export function assertCodexAccountId(id: string): void {
  if (!isSafeAccountId(id)) throw new Error('Invalid Codex account id')
}

/** The pre-migration long home, `<userData>/codex-accounts/<id>`, moved to the short home at boot. */
export function legacyCodexAccountHome(userDataDir: string, accountId: string): string {
  assertCodexAccountId(accountId)
  return path.join(userDataDir, 'codex-accounts', accountId)
}

/**
 * A managed account's local home, `~/.nodeterm/cx/<sha256(userDataDir\0accountId)[0..16]>`, mode
 * `0o700`. The digest is deliberately SHORT: the app-server control socket lives two levels below
 * it (`<home>/app-server-control/app-server-control.sock`) and must stay under macOS `SUN_LEN` —
 * the normal Electron userData path plus a UUID already overshoots. `userDataDir` is folded into
 * the digest so separate NodeTerm profiles never collide, without a global static account root.
 */
export function codexAccountHome(
  userDataDir: string,
  accountId: string,
  shortRoot = path.join(os.homedir(), '.nodeterm', 'cx')
): string {
  assertCodexAccountId(accountId)
  const digest = createHash('sha256')
    .update(userDataDir)
    .update('\0')
    .update(accountId)
    .digest('hex')
    .slice(0, 16)
  return path.join(shortRoot, digest)
}

/**
 * Move one legacy long home to its deterministic short home, fail-closed: no-op if the legacy dir
 * is absent, the target already exists, or the paths coincide. An id that fails the regex throws
 * (via `legacyCodexAccountHome`) and is therefore left untouched by the boot sweep below.
 */
export function migrateLegacyCodexAccountHome(
  userDataDir: string,
  accountId: string,
  shortRoot?: string
): string {
  const legacy = legacyCodexAccountHome(userDataDir, accountId)
  const target = codexAccountHome(userDataDir, accountId, shortRoot)
  if (legacy === target || !existsSync(legacy) || existsSync(target)) return target
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  renameSync(legacy, target)
  return target
}

/** Boot sweep: migrate every legacy managed home. Invalid / unmovable entries are left in place. */
export function migrateLegacyCodexAccountHomes(userDataDir: string, shortRoot?: string): void {
  const legacyRoot = path.join(userDataDir, 'codex-accounts')
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = readdirSync(legacyRoot, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      migrateLegacyCodexAccountHome(userDataDir, entry.name, shortRoot)
    } catch {
      // Invalid/unmovable entries remain untouched and therefore fail closed.
    }
  }
}

/** The SYSTEM Codex home: `$CODEX_HOME` when set to an absolute path, else `~/.codex`. */
export function systemCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim()
  return configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.codex')
}

/** System vs managed is presence/absence of an id: no id ⇒ `~/.codex`; a valid id ⇒ its short home. */
export function codexHomeForAccount(userDataDir: string, accountId?: string): string {
  return accountId ? codexAccountHome(userDataDir, accountId) : systemCodexHome()
}

/** The one persistent app-server's control socket for an account (system or managed). */
export function codexSocketForAccount(userDataDir: string, accountId?: string): string {
  return path.join(
    codexHomeForAccount(userDataDir, accountId),
    'app-server-control',
    'app-server-control.sock'
  )
}

/** Short, deterministic remote homes keep the app-server Unix socket below SUN_LEN. A remote host
 *  has ONE home root, so the digest is over `accountId` only. */
export function remoteCodexHome(remoteHome: string, accountId?: string): string {
  if (!path.posix.isAbsolute(remoteHome)) throw new Error('Remote home must be absolute')
  if (!accountId) return path.posix.join(remoteHome, '.codex')
  assertCodexAccountId(accountId)
  const digest = createHash('sha256').update(accountId).digest('hex').slice(0, 16)
  return path.posix.join(remoteHome, '.nodeterm', 'cx', digest)
}

export function remoteCodexSocket(remoteHome: string, accountId?: string): string {
  return path.posix.join(
    remoteCodexHome(remoteHome, accountId),
    'app-server-control',
    'app-server-control.sock'
  )
}

export function remoteCodexSessionEnv(
  remoteHome: string,
  accountId?: string
): { CODEX_HOME: string; NODETERM_CODEX_ACCOUNT_ID: string } {
  return {
    CODEX_HOME: remoteCodexHome(remoteHome, accountId),
    NODETERM_CODEX_ACCOUNT_ID: accountId ?? ''
  }
}

export function remoteCodexTmuxEnvArgs(remoteHome: string, accountId?: string): string[] {
  return Object.entries(remoteCodexSessionEnv(remoteHome, accountId)).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`
  ])
}

/**
 * Explicit per-session env. An EMPTY account id means the system account and is written
 * explicitly, so it OVERWRITES any managed `NODETERM_CODEX_ACCOUNT_ID` inherited from a parent
 * (tmux shares one server env) rather than silently acting as the wrong login.
 */
export function codexSessionEnv(
  userDataDir: string,
  accountId?: string
): { CODEX_HOME: string; NODETERM_CODEX_ACCOUNT_ID: string } {
  return {
    CODEX_HOME: codexHomeForAccount(userDataDir, accountId),
    NODETERM_CODEX_ACCOUNT_ID: accountId ?? ''
  }
}

/** A refusal carrying the same `unavailable` code the spawn layer surfaces to the renderer. */
export interface CodexScopeRefusal {
  unavailable: 'codex-account'
}
export type CodexSessionScope =
  | { CODEX_HOME: string; NODETERM_CODEX_ACCOUNT_ID: string }
  | CodexScopeRefusal

export function isCodexScopeRefusal(scope: CodexSessionScope): scope is CodexScopeRefusal {
  return (scope as CodexScopeRefusal).unavailable === 'codex-account'
}

/**
 * Resolve the session scope for a Codex spawn, fail-closed (S6 Decision 2 / §5 property 4).
 *
 * An EXPLICITLY selected managed account whose home is missing REFUSES (`{ unavailable:
 * 'codex-account' }`) — it never falls back to the system home. This is deliberately STRICTER than
 * the Claude sibling's `pty-manager` fallback: silently acting as the wrong login is a worse
 * failure for an explicit switch than for a first spawn. The system account (no id) always
 * resolves and, per `codexSessionEnv`, explicitly clears any inherited managed scope.
 *
 * `homeExists` is injected so the spawn layer passes real `existsSync` and this stays testable
 * against a real temp filesystem. The later `pty-manager` PR maps `unavailable` straight through.
 */
export function resolveCodexSessionScope(
  userDataDir: string,
  accountId: string | undefined,
  homeExists: (home: string) => boolean = existsSync
): CodexSessionScope {
  if (!accountId) return codexSessionEnv(userDataDir)
  assertCodexAccountId(accountId)
  const home = codexAccountHome(userDataDir, accountId)
  if (!homeExists(home)) return { unavailable: 'codex-account' }
  return { CODEX_HOME: home, NODETERM_CODEX_ACCOUNT_ID: accountId }
}

/**
 * Codex agents need an explicit system-or-managed scope; a plain login terminal needs it when it
 * carries a managed account id. Sharing this predicate keeps tmux and plain PTYs aligned.
 */
export function needsCodexAccountScope(agentId?: string, accountId?: string): boolean {
  return agentId === 'codex' || !!accountId
}

/**
 * Usage discovery follows actual account HOMES, not the renderer's eventually-consistent `pending`
 * marker: a completed auth file can exist after a restart before settings reconciles, and the
 * provider itself safely reports `unavailable` when a home is not logged in yet. Consumed by the
 * usage PR.
 */
export function codexUsageAccounts(
  accounts: ReadonlyArray<{
    id: string
    label: string
    email?: string | null
    pending?: boolean
  }>,
  homeFor: (accountId: string) => string
): Array<{ id: string; home: string; label: string; email?: string | null }> {
  return accounts.map((account) => ({
    id: account.id,
    home: homeFor(account.id),
    label: account.label,
    email: account.email
  }))
}

/** tmux has a shared server env, so both values must be set explicitly per new Codex session. */
export function codexTmuxEnvArgs(userDataDir: string, accountId?: string): string[] {
  return Object.entries(codexSessionEnv(userDataDir, accountId)).flatMap(([key, value]) => [
    '-e',
    `${key}=${value}`
  ])
}

/**
 * Env vars that would silently SHADOW the selected account's OAuth login (`auth.json`) by forcing
 * API-key auth instead — the Codex analogue of Claude's `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`
 * strip. Removed from the session env at spawn so a managed account always acts as its own login.
 * A credential is never placed on argv (the hook-token-argv lesson); this only touches the env.
 */
export const AUTH_ENV_STRIP = ['OPENAI_API_KEY', 'CODEX_API_KEY'] as const

/** Return a copy of `env` with every `AUTH_ENV_STRIP` var removed. Applied at spawn by the pty PR. */
export function stripCodexAuthEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const out = { ...env }
  for (const key of AUTH_ENV_STRIP) delete out[key]
  return out
}
