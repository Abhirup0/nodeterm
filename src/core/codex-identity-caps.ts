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
 * Two things have to be true, and neither is knowable from the renderer:
 *  1. the hook server holds the per-node auth secret (no secret ⇒ no capability token ⇒ the
 *     launcher would fall back anyway, one process later), and
 *  2. the generated launcher could actually be written (a read-only or full data dir is a real
 *     failure mode, and it is the one the renderer cannot see at all).
 *
 * SERVER EDITION: `src/server` deliberately registers this and answers `false` — see the comment
 * at its registration site. That is what makes "Server Edition runs plain codex" a decision rather
 * than an accident.
 */
import { IPC } from '../shared/ipc'
import { platform } from './platform'
import { UNKNOWN_CODEX_IDENTITY_CAPS, type CodexIdentityCaps } from '../shared/types'
import { installCodexLauncher, codexThreadIdentityAvailable } from './codex-identity-proxy'

let latest: CodexIdentityCaps | null = null
let ready: Promise<CodexIdentityCaps> | null = null
let announce: ((c: CodexIdentityCaps) => void) | null = null

/**
 * Compute the answer and publish it. Called once by the shell, AFTER the node-auth secret has been
 * set (or has definitively failed), because the secret is half of what "shared" means.
 */
export function refreshCodexIdentityCaps(): CodexIdentityCaps {
  const launcher = codexThreadIdentityAvailable() ? installCodexLauncher() : null
  latest = { shared: !!launcher, launcherPath: launcher }
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
