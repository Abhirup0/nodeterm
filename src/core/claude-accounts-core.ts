// Pure logic for managed Claude accounts (config-dir isolation). No fs/electron imports —
// everything here is unit-tested; the impure lifecycle lives in claude-accounts.ts.
import { createHash } from 'crypto'
import path from 'path'
import { MODEL_GATEWAY_ENV_KEYS } from '../shared/agents/model-gateway'

/** Shape of a valid account id (uuid / opaque token). Shared by every path builder so a bad id
 *  can never traverse out of the accounts root — locally OR on a remote host over ssh. */
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]+$/
/** The same rule as a predicate, for callers that must REFUSE a bad id rather than throw on it —
 *  `project-node-append` validates the account id a phone sends over the relay before writing it
 *  into a project file. One definition: a second copy of this alphabet would drift out of step
 *  with the path builders it exists to protect. */
export function isSafeAccountId(accountId: string): boolean {
  return ACCOUNT_ID_RE.test(accountId)
}
function assertAccountId(accountId: string): void {
  if (!isSafeAccountId(accountId)) {
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
 * Legitimate local transcripts live under exactly these roots:
 *   - claude's system default `~/.claude/projects`,
 *   - a managed account's `{userData}/claude-accounts/<accountId>/projects`,
 *   - gemini's `~/.gemini/tmp` (its chats are `<project>/chats/session-*.jsonl`), and
 *   - codex's `<codexHome>/sessions` (its rollouts are `YYYY/MM/DD/rollout-*.jsonl`).
 * For the account root the `<accountId>` segment is validated with `ACCOUNT_ID_RE` (dots barred,
 * so `..` can never sneak in) and the very next segment must be `projects` — a prefix match on
 * `{userData}/claude-accounts` alone is NOT enough (it would accept `…/claude-accounts/x/.ssh`).
 * `abs` must already be resolved/normalized by the caller (e.g. `path.resolve(tp)`).
 *
 * `codexHomeDir` is where codex keeps its state — `$CODEX_HOME` when the user has moved it, which
 * `core/usage/codex-usage.ts`'s `codexHome()` already resolves for the usage reader. Trailing and
 * optional, defaulting to `<homeDir>/.codex`, so every pre-existing caller is unchanged. It is a
 * PARAMETER rather than an env read because this module is pure path math: the shells own the env.
 * Getting it wrong fails CLOSED (a relocated codex home would silently never fill its meter, not
 * leak anything) — which is the quieter and therefore worse failure, hence the parameter.
 */
export function isSafeLocalTranscriptPath(
  abs: string,
  homeDir: string,
  userDataPath: string,
  codexHomeDir?: string,
  grokHomeDir?: string
): boolean {
  const legacyRoot = path.join(homeDir, '.claude', 'projects')
  if (abs === legacyRoot || abs.startsWith(legacyRoot + path.sep)) return true
  // gemini and codex keep their transcripts in their OWN trees, which the context meter for those
  // agents reads (core/gemini-session.ts, core/codex-session.ts). Each root is the narrowest one
  // that holds them — the same directories `handoff/locate.ts` already walks to find a session
  // file. Deliberately NOT `$HOME`: this predicate exists precisely so a forged POST cannot aim a
  // read at `~/.ssh/id_rsa`, and a home-wide allowance would hand that straight back.
  const geminiRoot = path.join(homeDir, '.gemini', 'tmp')
  if (abs === geminiRoot || abs.startsWith(geminiRoot + path.sep)) return true
  const codexRoot = path.join(codexHomeDir || path.join(homeDir, '.codex'), 'sessions')
  if (abs === codexRoot || abs.startsWith(codexRoot + path.sep)) return true
  // grok: `$GROK_HOME/sessions/<url-encoded cwd>/<sessionId>/`. `sessions` and not `$GROK_HOME`,
  // because the same tree holds `auth.json` — a home-wide allowance would put the user's bearer
  // token inside the jail this predicate exists to keep it out of. Same parameter discipline as
  // codex: the shells own the env (`grokHomeDir()` in `agents/grok-paths.ts` resolves $GROK_HOME),
  // this module stays pure path math, and getting it wrong fails CLOSED — a relocated grok home
  // means the context link silently never resolves, never a widened read.
  const grokRoot = path.join(grokHomeDir || path.join(homeDir, '.grok'), 'sessions')
  if (abs === grokRoot || abs.startsWith(grokRoot + path.sep)) return true
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

/** Where each supported agent keeps its config, credentials and (for opencode) its plugin code.
 *  One list because they are one hazard — see `isReservedSpawnEnvKey`'s clause on them. */
const AGENT_CONFIG_DIR_ENV: readonly string[] = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME']

/**
 * Names that make a program EXECUTE something it was never asked to, without changing which program
 * was launched. `NODE_OPTIONS`'s exact reserve-reason, one interpreter down and one shell over —
 * three mechanisms, one list because they are one hazard (see `isReservedSpawnEnvKey`'s clause):
 *  - `LD_PRELOAD` / `LD_AUDIT` / `LD_LIBRARY_PATH` — the Linux dynamic loader loads a repo-supplied
 *    `.so` into the CLI's own address space before `main` runs.
 *  - `DYLD_INSERT_LIBRARIES` / `DYLD_LIBRARY_PATH` — the macOS equivalent. macOS strips DYLD_* only
 *    across a SIP-protected or hardened-runtime boundary, and a node/agent CLI is neither: it is a
 *    script run by the user's own `node`, so the pair applies exactly as on Linux.
 *  - `BASH_ENV` / `ENV` — sourced by a NON-interactive shell at startup, which is precisely the
 *    shell every launch line runs in; the file runs before the agent's first byte.
 *  - `GIT_SSH_COMMAND` / `GIT_EXTERNAL_DIFF` — git runs the named command verbatim the moment the
 *    agent (or the user) shells out to git, which an agent pane does constantly.
 * Every one of them renders as an innocuous path or command string in the consent table while
 * granting arbitrary execution inside a binary the user believes untouched — the NODE_OPTIONS
 * bucket, not the PATH bucket. Spec §2 names LD_PRELOAD as attack surface by name.
 *
 * Honest cost, same shape as the `XDG_CONFIG_HOME` overreach documented below: `ENV` and
 * `LD_LIBRARY_PATH` are ALSO ordinary application variables (a project that genuinely wanted
 * `LD_LIBRARY_PATH=./vendor/lib` for its own toolchain cannot set it through project env, and must
 * use custom-agent env or the shell's rc instead). Kept, because a per-key "is this one being used
 * innocently?" judgement is not something the merge point can make, and the failure direction of
 * guessing wrong is arbitrary code execution.
 */
const INJECTION_ENV: readonly string[] = [
  'LD_PRELOAD',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
  'BASH_ENV',
  'ENV'
]

/**
 * Env keys a PROJECT's settings document may never contribute to a spawn, however it is sourced
 * and however it was consented to (`makeProjectSpawnOverrides` → `PtyManager.spawnSession`, both
 * the local merge and the ssh `remoteEnvPairs` join).
 *
 * WHY, given the value already passed a trust dialog: consent proves a human saw the PAIRS, not
 * that they understood what each one out-ranks. A project's settings.json is a git-shared file —
 * one commit reaches every clone — and it is merged AFTER the three layers whose entire job is to
 * control these exact names:
 *  - `AUTH_ENV_STRIP` is DELETED from the env when a managed account is selected, precisely so an
 *    inherited API key cannot shadow that account's OAuth login. A project re-adding one silently
 *    routes the session's traffic to a third party.
 *  - AGENT CONFIG DIRS — one clause, three names, because every supported agent has one and a repo
 *    naming any of them redirects that agent's credentials or code loading into itself. All three
 *    read like build directories (`./.tooling`) in a consent table:
 *      · `CLAUDE_CONFIG_DIR` — where claude reads and WRITES credentials (the account path sets it).
 *      · `CODEX_HOME` — the same for codex (`auth.json` lives there; this app emits it in
 *        `usage/codex-usage.ts`, and the launched pane resolves it from its OWN environment, see
 *        `codex-identity-proxy.ts`), so a repo-supplied value captures codex's auth writes.
 *      · `XDG_CONFIG_HOME` — opencode is XDG-respecting and loads its plugins from
 *        `$XDG_CONFIG_HOME/opencode` (`agents/hooks/opencode.ts`), which is where THIS app installs
 *        its managed plugin. A repo pointing that at itself is arbitrary JavaScript executed inside
 *        the agent process — the worst of the three, and the least legible as an env pair.
 *  - `MODEL_GATEWAY_ENV_KEYS` — the provider ROUTING vars (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
 *    `COPILOT_PROVIDER_BASE_URL`, and the keys that travel with them). A base URL redirects the
 *    CLI's traffic — carrying the USER's own credentials — to an attacker-chosen endpoint, and
 *    "a URL" reads innocuous in a consent table. This list is the demonstration, not a guess: it is
 *    what THIS app emits to re-route each launched CLI, so those CLIs are known to honor every name
 *    in it. Custom-agent env may still set these — that is the documented proxy use case.
 *  - `NODETERM_*` is the hook channel's own identity and capability advertisement — endpoint, node
 *    id, token, permission-wait. Forging any of them lets one node speak as another.
 *  - `NODE_OPTIONS` — `--require /repo/x.js` loads arbitrary JavaScript into every node-based CLI
 *    (claude first among them) at interpreter start. Same class as the opencode-plugin path above,
 *    and stealthier than PATH: the process still IS the real claude, from the real location, so
 *    nothing downstream — not the pane, not the identity probe — can tell. The dialog shows a flag
 *    string; the grant is code execution.
 *  - `INJECTION_ENV` — the same grant through the DYNAMIC LOADER (`LD_PRELOAD` and friends; the
 *    macOS `DYLD_*` pair, which a non-SIP-protected node/agent CLI honors just as Linux does), the
 *    NON-interactive shell's own startup file (`BASH_ENV` / `ENV`, sourced by the very shell the
 *    launch line runs in), and git's command hooks (`GIT_SSH_COMMAND` / `GIT_EXTERNAL_DIFF`, run
 *    verbatim as soon as the agent shells out to git). One reserve-reason with NODE_OPTIONS: the
 *    process still IS the real CLI, from the real location, and the table showed "a path".
 *
 * WHAT IS DELIBERATELY *NOT* HERE — `PATH`, and every ordinary application variable. Approving
 * `PATH=./bin` is a COHERENT consent: "this project's terminals resolve tools from the repo" is the
 * feature's stated purpose, and the hijack it enables still requires committing a visible binary
 * that a reviewer can see in the tree. `NODE_OPTIONS` fails exactly that test, which is why it sits
 * above and PATH does not — it smuggles execution into a binary the user believes untouched.
 *
 * The reserved list exists only for keys whose implications a dialog CANNOT convey — a credential
 * directory, a silent traffic redirect, a hook identity, an interpreter preload — where what is
 * shown ("a path", "a URL", "a flag") and what is granted are different things. The line is
 * legibility, not danger; a project that wants its own auth belongs in a custom agent.
 *
 * SCOPE, precisely: this filters the project's contribution — BOTH halves of it, the git-shared
 * document AND this machine's local overlay. That is broader than the hostile-input argument
 * strictly requires, and it is the deliberate trade: one rule is auditable where "reserved unless
 * it came from the overlay" would be a provenance check on every key, at the spawn, forever.
 *
 * The same overreach applies by AGENT: `XDG_CONFIG_HOME` is reserved for every pane, including a
 * plain terminal that launches no agent at all and where the opencode-plugin hazard cannot arise.
 * Kept anyway, for the same one-auditable-rule reason — the alternative is a per-agent reserved list
 * evaluated at the spawn, and a pane's agent can change under it. The honest cost: someone who
 * wanted to point a project's shells at repo-local dotfiles through project env cannot, and the
 * local overlay is no workaround because this filter covers that too. What is left is custom-agent
 * env (per-machine configuration the user typed themselves, merged after and over this) for an agent
 * pane, or the shell's own rc for a plain one.
 *
 * Filtered SILENTLY at the merge — a spawn is not a place to raise a second question. So a dropped
 * key is currently invisible to its author; surfacing the skipped keys in the project settings
 * panel is left to the observability wave.
 */
export function isReservedSpawnEnvKey(key: string): boolean {
  return (
    key.startsWith('NODETERM_') ||
    key === 'NODE_OPTIONS' ||
    INJECTION_ENV.includes(key) ||
    AGENT_CONFIG_DIR_ENV.includes(key) ||
    (AUTH_ENV_STRIP as readonly string[]).includes(key) ||
    (MODEL_GATEWAY_ENV_KEYS as readonly string[]).includes(key)
  )
}

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
