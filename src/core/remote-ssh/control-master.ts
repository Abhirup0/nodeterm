// Pure ssh/tmux argv + remote-command builders for SSH projects. No electron/node-pty imports
// — unit-testable in isolation. The electron/spawn wiring lives in ssh-project.ts + pty-manager.
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { posixQuote, quoteRemotePath, remoteTmuxCommand, type SshConnection } from '../../shared/ssh'
// Dependency-free (no node-pty): safe to import from these pure builders.

/** Dedicated remote tmux socket so an SSH project never collides with the user's own tmux. */
export const RMT_TMUX_SOCKET = 'nodeterm-rmt'

/**
 * Per-project ControlMaster socket path. Deliberately SHORT and space-free. The macOS userData dir
 * (`~/Library/Application Support/<app>`) cannot host the socket: it both exceeds the unix-domain
 * socket `sun_path` limit (104 bytes — and ssh appends a ~17-char temp suffix while binding the
 * master, pushing a ~102-char path over) AND contains a space, which ssh's `-o ControlPath=` parser
 * rejects ("extra arguments at end of line"). Either makes the master silently fail to bind. So we
 * hash the project id to a fixed length under a short home dir (`~/.nodeterm/ssh-cm/`) — the master
 * socket then always binds, regardless of project id or platform userData location.
 */
export function controlPathFor(projectId: string): string {
  const id = createHash('sha256').update(projectId).digest('hex').slice(0, 16)
  return path.join(os.homedir(), '.nodeterm', 'ssh-cm', `${id}.sock`)
}

function target(conn: SshConnection): string {
  return `${conn.user}@${conn.host}`
}

function portArgs(conn: SshConnection): string[] {
  return ['-p', String(conn.port ?? 22)]
}

/** Args for the backgrounded multiplexing master (the one auth happens here). */
export function masterArgs(conn: SshConnection, controlPath: string): string[] {
  const args = [
    '-M',
    '-N',
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlPath}`,
    '-o',
    'ControlPersist=300',
    '-o',
    'BatchMode=no',
    // Keepalives on the ONE connection every terminal multiplexes over: keep NAT/firewall
    // entries warm, and detect a dead link in ~60s (15s × 4) instead of hanging half-dead
    // after sleep/wake or a network change. The client then exits 255 and the renderer's
    // SshReconnector takes over.
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    ...portArgs(conn)
  ]
  if (conn.identityFile) args.push('-i', conn.identityFile)
  args.push(target(conn))
  return args
}

/** Args for a child ssh that reuses the master socket; `remote` is an optional remote command. */
export function childArgs(conn: SshConnection, controlPath: string, remote?: string): string[] {
  const args = ['-o', 'ControlMaster=no', '-o', `ControlPath=${controlPath}`, ...portArgs(conn), target(conn)]
  if (remote !== undefined) args.push(remote)
  return args
}

export function checkMasterArgs(conn: SshConnection, controlPath: string): string[] {
  return ['-O', 'check', '-o', `ControlPath=${controlPath}`, ...portArgs(conn), target(conn)]
}
export function exitMasterArgs(conn: SshConnection, controlPath: string): string[] {
  return ['-O', 'exit', '-o', `ControlPath=${controlPath}`, ...portArgs(conn), target(conn)]
}
export function remoteTmuxHasSessionArgs(conn: SshConnection, controlPath: string, sessionId: string): string[] {
  return childArgs(conn, controlPath, `tmux -L ${RMT_TMUX_SOCKET} has-session -t ${sessionId}`)
}
/**
 * Send literal text (and optionally Enter) into a node's REMOTE tmux session — the remote
 * counterpart of `PtyManager.sendText`'s local `tmux send-keys` path (dictation insert, /rename,
 * /branch, note pushes). Built as ONE remote command so text and Enter run strictly in order on
 * the remote host without a second network round trip: `-l --` sends the text literally (`-l`)
 * and stops option parsing first (`--`, so text starting with `-` is never read as another
 * send-keys flag); `text` is single-quoted (`posixQuote`) so it survives the remote shell as one
 * token verbatim, multiline included. Joined with `&&`, not `;` — this mirrors the local path's
 * ordering guarantee (`PtyManager.sendText`): Enter only fires if the text send actually
 * succeeded, so a failed text send can never leave a lone Enter to submit whatever was already
 * composed in a live agent prompt.
 */
export function remoteTmuxSendKeysArgs(
  conn: SshConnection,
  controlPath: string,
  sessionId: string,
  text: string,
  enter: boolean
): string[] {
  let cmd = `tmux -L ${RMT_TMUX_SOCKET} send-keys -t ${sessionId} -l -- ${posixQuote(text)}`
  if (enter) cmd += ` && tmux -L ${RMT_TMUX_SOCKET} send-keys -t ${sessionId} Enter`
  return childArgs(conn, controlPath, cmd)
}
/**
 * Did a FAILED `tmux has-session` probe actually say the session is absent? Only tmux's own
 * exit 1 ("can't find session" / "no server running") does. Anything else — ssh's 255 (a dead
 * or mid-reconnect ControlMaster), 127 (tmux off the remote PATH), a spawn error with no
 * numeric code — is a failed READ, and a failed read is never evidence of absence. Reading a
 * transport failure as "cold" made the desktop replay scrollback and type `claude --resume …`
 * into a LIVE fullscreen Claude session; the mangled line then landed in the agent's
 * conversation as a user prompt (field report). Unknown ⇒ warm attach, which types nothing.
 */
export function probeSaysAbsent(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 1
}
export function remoteTmuxKillArgs(conn: SshConnection, controlPath: string, sessionId: string): string[] {
  return childArgs(conn, controlPath, `tmux -L ${RMT_TMUX_SOCKET} kill-session -t ${sessionId}`)
}
export function remoteCapturePaneArgs(conn: SshConnection, controlPath: string, sessionId: string, full: boolean): string[] {
  return childArgs(
    conn,
    controlPath,
    `tmux -L ${RMT_TMUX_SOCKET} capture-pane -p -e -t ${sessionId} -S ${full ? '-' : '-200'}`
  )
}
export function tmuxProbeArgs(conn: SshConnection, controlPath: string): string[] {
  return childArgs(conn, controlPath, 'command -v tmux')
}
export function listDirArgs(conn: SshConnection, controlPath: string, path: string): string[] {
  return childArgs(conn, controlPath, `ls -1Ap ${quoteRemotePath(path)}`)
}

/** Create a remote directory (and any missing parents). `quoteRemotePath` keeps a leading `~`. */
export function mkDirArgs(conn: SshConnection, controlPath: string, path: string): string[] {
  return childArgs(conn, controlPath, `mkdir -p ${quoteRemotePath(path)}`)
}

/** scp argv that reuses the project's ControlMaster. `localPath` is a raw local arg; the absolute
 *  `remotePath` is passed RAW (NOT posixQuote'd). Modern scp (OpenSSH 9+) uses the SFTP protocol by
 *  default and does NOT run the remote path through a shell — it opens the literal string after the
 *  `host:`, so a quoted path makes the SFTP server look for a file literally named `'…'` (the upload
 *  then silently fails). Leaving it raw means SFTP opens the exact absolute path (spaces and all);
 *  there is no remote shell, so no quoting is needed and no injection is possible (`fileName` is also
 *  basenamed by the caller, and the path is absolute). scp uses `-P` (uppercase) for the port. */
export function scpArgs(conn: SshConnection, controlPath: string, localPath: string, remotePath: string): string[] {
  const args = ['-o', 'ControlMaster=no', '-o', `ControlPath=${controlPath}`, '-o', 'BatchMode=yes', '-P', String(conn.port ?? 22)]
  if (conn.identityFile) args.push('-i', conn.identityFile)
  args.push(localPath, `${conn.user}@${conn.host}:${remotePath}`)
  return args
}

/**
 * Reverse-forward the local hook server's loopback TCP port to a remote unix socket over the
 * existing master (`ssh -O forward -R <remoteSock>:127.0.0.1:<hookPort>`), so remote hook scripts
 * can POST to it via `curl --unix-socket`.
 */
function fwdSpec(remoteSock: string, hookPort: number): string {
  return `${remoteSock}:127.0.0.1:${hookPort}`
}
export function hookForwardArgs(conn: SshConnection, controlPath: string, remoteSock: string, hookPort: number): string[] {
  return ['-O', 'forward', '-R', fwdSpec(remoteSock, hookPort), '-o', `ControlPath=${controlPath}`, ...portArgs(conn), target(conn)]
}
export function hookForwardCancelArgs(conn: SshConnection, controlPath: string, remoteSock: string, hookPort: number): string[] {
  return ['-O', 'cancel', '-R', fwdSpec(remoteSock, hookPort), '-o', `ControlPath=${controlPath}`, ...portArgs(conn), target(conn)]
}
/** tmux `-e KEY=VALUE` pairs injecting the remote hook endpoint file + node id + protocol version. */
export function remoteHookEnvArgs(endpointPath: string, nodeId: string, version: string): string[] {
  return ['-e', `NODETERM_HOOK_ENDPOINT=${endpointPath}`, '-e', `NODETERM_NODE_ID=${nodeId}`, '-e', `NODETERM_HOOK_VERSION=${version}`]
}
/** Contents of the remote endpoint env file the managed hook script sources (unix-socket transport). */
export function remoteEndpointFileContents(sock: string, token: string, version: string): string {
  return `NODETERM_HOOK_SOCK=${sock}\nNODETERM_HOOK_TOKEN=${token}\nNODETERM_HOOK_VERSION=${version}\n`
}

/**
 * The remote PTY program is `ssh <childArgs> host -t '<remoteTmuxCommand>'`. `extraEnv` is an
 * already-built list of tmux `-e KEY=VALUE` pairs (e.g. from `remoteHookEnvArgs`) spliced into
 * the `new-session` command right after `-A`, mirroring the local tmux `-e` placement.
 */
export function remoteTmuxPtyArgs(
  conn: SshConnection,
  controlPath: string,
  sessionId: string,
  remoteCwd: string,
  program?: string,
  programArgs?: string[],
  extraEnv: string[] = [],
  confPath?: string
): string[] {
  let cmd = remoteTmuxCommand({ sessionId, remoteCwd, program, programArgs, socket: RMT_TMUX_SOCKET, confPath })
  if (extraEnv.length) cmd = cmd.replace('new-session -A ', `new-session -A ${extraEnv.join(' ')} `)
  return ['-t', ...childArgs(conn, controlPath, cmd)]
}
