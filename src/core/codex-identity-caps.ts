/**
 * "Can a node on THIS machine get a managed Codex identity?" — the construction-time half of the
 * fallback.
 *
 * Shaped exactly like `core/claude-cli.ts`: a memoized probe behind one CorePlatform RPC channel,
 * registered by BOTH shells, whose unknown answer is the conservative one. The renderer asks it
 * before it writes a launch line, and a `false` means the line stays the bare `codex` it has
 * always been — never a launcher path that might not resolve, which would be a dead node.
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

let cached: CodexIdentityCaps | null = null

/** Recompute now. Called at wiring time and again whenever the launcher is (re)installed. */
export function refreshCodexIdentityCaps(): CodexIdentityCaps {
  const launcher = codexThreadIdentityAvailable() ? installCodexLauncher() : null
  cached = { shared: !!launcher, launcherPath: launcher }
  return cached
}

export function codexIdentityCaps(): CodexIdentityCaps {
  return cached ?? UNKNOWN_CODEX_IDENTITY_CAPS
}

/** Wire the answer onto the platform's RPC surface (Electron ipcMain / server WS-RPC alike). */
export function registerCodexIdentityIpc(answer: () => CodexIdentityCaps = codexIdentityCaps): void {
  platform().handle(IPC.codexIdentityCaps, () => answer())
}

export function resetCodexIdentityCapsForTests(): void {
  cached = null
}
