/**
 * "Can a node on THIS machine get a managed Codex identity?" — the construction-time half of the
 * fallback.
 *
 * Modelled on `core/claude-cli.ts`: one answer behind one CorePlatform RPC channel, registered by
 * BOTH shells, whose unknown answer is the conservative one. The renderer asks it before it writes
 * a launch line, and a `false` means the line stays the bare `codex` it has always been — never a
 * launcher path that might not resolve, which would be a dead node.
 *
 * It differs from claude's in WHERE the work happens: claude's probe is lazy and self-starting
 * (`claude --version` can run whenever someone first asks), while this one cannot compute anything
 * until the shell has handed the hook server its node-auth secret. So the shell PUSHES the answer
 * in (`refreshCodexIdentityCaps`) and a caller that arrives first WAITS for it — see
 * `codexIdentityCaps` below for why waiting, rather than answering "no", is the only safe default
 * here.
 *
 * Three things have to be true, and none is knowable from the renderer:
 *  1. the hook server holds the per-node auth secret (no secret ⇒ no capability token ⇒ the
 *     launcher would fall back anyway, one process later),
 *  2. the generated launcher could actually be written (a read-only or full data dir is a real
 *     failure mode, and it is the one the renderer cannot see at all), and
 *  3. the installed `codex` accepts `--remote` — see `codexCliSupportsRemote`. This is the only
 *     one that cannot be recovered from at runtime: the launcher's preflight proves that
 *     `codex app-server daemon start` exits 0, and then EXECS. A CLI with an app-server but no
 *     `--remote` dies on a clap usage error after that exec, where there is no fallback left. So
 *     it is answered here, once per app run, entirely off the launch path.
 *
 * SERVER EDITION: `src/server` deliberately registers this and answers `false` — see the comment
 * at its registration site. That is what makes "Server Edition runs plain codex" a decision rather
 * than an accident.
 */
import { execFile } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../shared/ipc'
import { platform } from './platform'
import { type CodexIdentityCaps } from '../shared/types'
import { installCodexLauncher, codexThreadIdentityAvailable } from './codex-identity-proxy'
import { findInLoginPath } from './pty-manager'

const execFileP = promisify(execFile)
const PROBE_TIMEOUT_MS = 5000

/**
 * Pure: help text → does this CLI accept `--remote`?
 *
 * FEATURE-detected from `--help`, never version-compared, for the same reason claude's
 * `--session-id` is: the release it appeared in is not documented anywhere this repo can check,
 * and an unrecognised flag does not degrade — it makes the CLI exit. Anchored on a word boundary
 * so `--remote-auth-token-env`, or prose mentioning the flag inside another option's description,
 * cannot answer yes for it.
 *
 * Absent help output ⇒ false ⇒ no shared identity ⇒ the bare `codex` command, exactly as before
 * this feature. That is the same direction every other unknown in this file degrades in: a wrong
 * "yes" here costs the node, a wrong "no" costs only the shared app-server.
 */
export function codexCliSupportsRemote(...helpOutputs: Array<string | null | undefined>): boolean {
  return helpOutputs.some((h) => /(^|\s)--remote(\s|=|$)/m.test(h ?? ''))
}

async function probeRemoteFlag(): Promise<boolean> {
  try {
    // GUI apps don't inherit the shell PATH — resolve through the login shell like every other
    // CLI lookup in the app (pty-manager, claude-cli, commit-message).
    const bin = await findInLoginPath('codex')
    if (!bin) return false
    const help = await execFileP(bin, ['--help'], { timeout: PROBE_TIMEOUT_MS })
      .then((r) => r.stdout)
      .catch(() => null)
    if (codexCliSupportsRemote(help)) return true
    // Some CLIs list a global flag only under the subcommand that takes it. One extra spawn, paid
    // once per app run and only when the top-level help did not already answer yes.
    const resumeHelp = await execFileP(bin, ['resume', '--help'], { timeout: PROBE_TIMEOUT_MS })
      .then((r) => r.stdout)
      .catch(() => null)
    return codexCliSupportsRemote(resumeHelp)
  } catch {
    // Missing CLI, timeout, non-zero exit — all mean "unknown", which means "no shared identity".
    return false
  }
}

let latest: CodexIdentityCaps | null = null
let ready: Promise<CodexIdentityCaps> | null = null
let announce: ((c: CodexIdentityCaps) => void) | null = null

/**
 * Compute the answer and publish it. Called once by the shell, AFTER the node-auth secret has been
 * set (or has definitively failed), because the secret is a third of what "shared" means.
 *
 * Async because of the `--remote` probe, which is a login-shell lookup plus up to two `--help`
 * spawns. That cost is paid HERE — once, during boot, with nothing waiting on it but the first
 * Codex launch line — and never on the launch path itself, where it would be visible latency in
 * the pane every single time, to answer a question whose answer cannot change while the app runs.
 */
export async function refreshCodexIdentityCaps(
  probeRemote: () => Promise<boolean> = probeRemoteFlag
): Promise<CodexIdentityCaps> {
  const remoteFlag = await probeRemote()
  const launcher = remoteFlag && codexThreadIdentityAvailable() ? installCodexLauncher() : null
  latest = { shared: !!launcher, launcherPath: launcher, remoteFlag }
  if (announce) {
    announce(latest)
    announce = null
  } else if (!ready) {
    ready = Promise.resolve(latest)
  }
  return latest
}

/**
 * The answer, ASYNC — like `claudeCliCaps()`, and for the same reason.
 *
 * An early caller must WAIT rather than be told "no". A sync getter would answer `false` to
 * anything that asked before `refreshCodexIdentityCaps()` ran, and since a `false` means no
 * launcher ever runs, it would pin the feature off for the whole session with no chip, no toast
 * and no log line to say so — one reordering of the boot chain away, invisibly. Waiting makes the
 * ordering a latency question instead of a correctness one. The renderer races this against its
 * own bounded timeout, so a shell that never refreshes costs a plain-codex session, not a hang.
 */
export function codexIdentityCaps(): Promise<CodexIdentityCaps> {
  if (latest) return Promise.resolve(latest)
  if (!ready) ready = new Promise((resolve) => (announce = resolve))
  return ready
}

/** Wire the answer onto the platform's RPC surface (Electron ipcMain / server WS-RPC alike). */
export function registerCodexIdentityIpc(
  answer: () => CodexIdentityCaps | Promise<CodexIdentityCaps> = codexIdentityCaps
): void {
  platform().handle(IPC.codexIdentityCaps, () => answer())
}

export function resetCodexIdentityCapsForTests(): void {
  latest = null
  ready = null
  announce = null
}
