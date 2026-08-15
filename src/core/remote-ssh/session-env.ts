// Argv-free env delivery for REMOTE agent sessions.
//
// The problem this solves: a remote node's gateway/custom env used to ride the ssh command as
// tmux `-e KEY=VALUE` pairs — parking the gateway API key on the LOCAL ssh client's argv for the
// whole session (world-readable /proc/<pid>/cmdline on a multi-user host, the PR #195 leak
// class) and on the remote process table at session creation. Now the VALUES travel in a 0600
// file staged over the ControlMaster (content via stdin — no argv anywhere), the remote command
// sources it into the tmux CLIENT's environment and deletes it, and the remote tmux conf's
// `update-environment` list copies the names into the session env at create/attach. Names (never
// values) may additionally ride a `set-option` argv for user-defined custom keys.
//
// The staging write is fire-and-forget from the spawn path (the same seam-injection pattern as
// node-token-service's remote writer: core cannot run ssh, main can). The remote command bridges
// the race with a bounded wait for the file; a file that never lands means the agent launches
// without its env and fails LOUDLY in the pane — fail-open never leaks and never hangs a spawn.

import { shellSingleQuote } from '../../shared/shell-quote'

export type RemoteSessionEnvWriter = (
  controlPath: string,
  remotePath: string,
  content: string
) => void

let writer: RemoteSessionEnvWriter | null = null

/** main (the ssh runner's owner) injects the actual uploader; the Server Edition wires nothing
 *  and staging degrades to the bounded-wait timeout + env-less launch. */
export function setRemoteSessionEnvWriter(w: RemoteSessionEnvWriter | null): void {
  writer = w
}

/** Fire-and-forget, fail-open: nothing here may throw into a pty spawn. */
export function stageRemoteSessionEnv(
  controlPath: string,
  remotePath: string,
  content: string
): void {
  try {
    writer?.(controlPath, remotePath, content)
  } catch {
    /* fail-open */
  }
}

/** Whether a writer is wired — the spawn path skips the remote wait-loop entirely when staging
 *  can never happen (Server Edition), instead of making every remote agent pay the full timeout. */
export function remoteSessionEnvAvailable(): boolean {
  return writer !== null
}

/** Env var names must be shell-identifier-shaped before they touch a sourced file or a
 *  `set-option` argv. Anything else is dropped (and the pair with it). */
export function isSafeEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/** The per-session env file path under the validated remote $HOME. The session name is
 *  `nt-<sanitized>` (tmux-naming), so the joined path needs no further quoting decisions here —
 *  callers still `posixQuote` it at the splice point. */
export function remoteSessionEnvPath(remoteHome: string, session: string): string {
  return `${remoteHome}/.nodeterm/env/${session}.env`
}

/** Render `export K='v'` lines. Values go through the same single-quote fence every typed
 *  command uses; unsafe NAMES are dropped entirely (a name is spliced bare on the left of `=`). */
export function sessionEnvFileContent(pairs: Record<string, string>): string {
  const lines: string[] = []
  for (const [k, v] of Object.entries(pairs)) {
    if (!isSafeEnvName(k)) continue
    lines.push(`export ${k}=${shellSingleQuote(v)}`)
  }
  return lines.join('\n') + '\n'
}
