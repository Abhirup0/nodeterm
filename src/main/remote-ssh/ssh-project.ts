import { promises as fs } from 'fs'
import path from 'path'
import { spawn, execFile, execFileSync } from 'child_process'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import { parseLsDirs, posixQuote, quoteRemotePath, remoteTmuxConf, sshHostKey, type SshConnection } from '../../shared/ssh'
import type { DownloadResult, SshProjectStatusEvent } from '../../shared/types'
import { candidateName, safeDownloadBasename } from '../../core/download-name'
import { remoteAccountConfigDir, isSupportedClaudeVersion } from '../../core/claude-accounts-core'
import { supportsAutoPermissionMode, supportsFullscreenTui } from '../../shared/agents/config'
import {
  controlPathFor,
  masterArgs,
  listDirArgs,
  mkDirArgs,
  exitMasterArgs,
  checkMasterArgs,
  remoteTmuxKillArgs,
  childArgs,
  scpArgs,
  scpDownArgs,
  RMT_TMUX_SOCKET
} from '../../core/remote-ssh/control-master'
import { claudeVersionProbeCommand, parseClaudeVersionProbe } from '../../core/remote-ssh/claude-version-probe'
import { RemoteHooks } from './remote-hooks'
import { hookServer } from '../../core/agents/hook-server'
import { sessionName } from '../../core/tmux-naming'

interface Runners {
  userDataDir: string
  /** Spawn the long-lived master; returns a handle we can kill. `stderr()` (when the spawner wires
   *  it) returns the master's captured stderr so a failed connect can surface the REAL ssh error
   *  (auth denied, host unreachable, host-key mismatch) instead of a generic timeout. */
  spawnMaster: (args: string[]) => {
    kill: () => void
    on: (ev: string, cb: (...a: unknown[]) => void) => void
    stderr?: () => string
  }
  /** Run a one-shot ssh, resolving its stdout + exit code; optional stdin written to the child. */
  run: (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>
  /** Run a one-shot scp (file upload over the master); resolves its exit code. */
  runScp: (args: string[]) => Promise<{ code: number }>
  /** Live loopback hook-server coordinates (injected so the manager stays testable). */
  getHook: () => { port: number; token: string; version: string }
  onStatus: (e: SshProjectStatusEvent) => void
  /** Delays between claude-probe retries after a FAILED attempt (claude not found). Injected so
   *  tests don't wait on real backoff; production uses PROBE_RETRY_DELAYS_MS. */
  probeRetryDelaysMs?: number[]
}

/** Backoff after a FAILED remote claude probe (no markers = claude not found on that attempt).
 *  A transient login-shell hiccup (nvm cache warm-up, NFS home, corp wrapper) shouldn't disable
 *  `--permission-mode auto` for the whole connection. A DEFINITE version answer never retries —
 *  a CLI doesn't change under a live connection; the next connect re-probes anyway. */
const PROBE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000]

/** How many `name (n)` variants a download tries before falling back to a stamped name. */
const DOWNLOAD_NAME_ATTEMPTS = 50

/** Cap on how much master stderr we retain (a misconfigured host can spew) — enough for the error. */
const MASTER_STDERR_CAP = 8 * 1024

/** Master watchdog cadence (see `startWatchdog`). Healthy cost per tick: ONE mux'd `-O check`
 *  per connected project — no new TCP/auth — so this can afford to be brisk; 45s bounds how
 *  long exec polls can churn direct-fallback connections after an unnoticed master death. */
const MASTER_WATCHDOG_MS = 45_000

/**
 * Pick the most informative line from an ssh master's stderr for the error banner. `-v` isn't
 * passed, so ordinary stderr has no `debug` noise, but we still skip `debug*`/`Warning:` lines and
 * take the LAST real line — ssh prints the actionable cause last ("Permission denied (publickey).",
 * "ssh: Could not resolve hostname …", "Host key verification failed."). Falls back to the last
 * non-empty line. Truncated so a runaway banner can't blow up the UI.
 */
export function lastSshErrorLine(stderr: string): string | undefined {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return undefined
  const meaningful = lines.filter((l) => !/^(debug\d*:|warning:)/i.test(l))
  const pick = (meaningful.length ? meaningful : lines).at(-1) ?? lines.at(-1)!
  return pick.length > 200 ? `${pick.slice(0, 200)}…` : pick
}

interface Conn {
  conn: SshConnection
  controlPath: string
  master: ReturnType<Runners['spawnMaster']>
  hookEndpointPath?: string
  /** The remote path of nodeterm's tmux.conf (`<remoteHome>/.nodeterm/tmux.conf`), written +
   * source-filed at connect. Threaded to `remoteTmuxCommand`'s `-f` so cold-start remote sessions
   * get mouse/clipboard/scrollback. Undefined if the write/source failed (fail-open). */
  tmuxConfPath?: string
  /** The remote `$HOME`, resolved at connect. Used (Phase 2b) to jail remote transcript reads
   * under `<remoteHome>/.claude/projects`. Undefined if it couldn't be resolved (fail-open). */
  remoteHome?: string
  /** The project's remote repo cwd (Phase 4). Lets `refForRemoteCwd` route remote git ops to this
   * connection's master. Undefined when the project has no folder selected. */
  remoteCwd?: string
  /** Does the REMOTE host's claude CLI accept `--permission-mode auto` (>= 2.1.71)? Probed at
   * connect (with bounded retries when claude wasn't found): the remote CLI can be older than the
   * local one, and the local answer must never be applied to a remote launch. Undefined/false ⇒
   * the renderer omits the flag for this project's Claude nodes (bare command — today's
   * behavior), never a failed launch. */
  claudeAutoPermissionMode?: boolean
  /** The probed remote `claude --version` output. `null` = the probe ran and found no claude
   * (feeds the tab-menu hint); undefined = not probed yet. */
  remoteClaudeVersion?: string | null
}

/**
 * Resolve an absolute ssh path; GUI apps don't inherit the shell PATH.
 * Mirrors findSsh() in pty-manager.ts: a cached login-shell `command -v ssh` lookup with
 * common-location fallbacks. (Do NOT use the brief's always-returns-first stub.)
 */
let cachedSsh: string | null | undefined
function sshBin(): string {
  if (cachedSsh !== undefined) return cachedSsh ?? 'ssh'
  try {
    const out = execFileSync(process.env.SHELL || '/bin/bash', ['-lc', 'command -v ssh'], {
      encoding: 'utf-8'
    }).trim()
    cachedSsh = out || null
  } catch {
    cachedSsh = null
  }
  if (!cachedSsh) {
    for (const p of ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh']) {
      try {
        execFileSync(p, ['-V'], { stdio: 'ignore' })
        cachedSsh = p
        break
      } catch {
        // keep trying
      }
    }
  }
  return cachedSsh ?? 'ssh'
}

/** Resolve an absolute `scp` path the same way `sshBin()` resolves `ssh` (GUI apps lack shell PATH). */
let cachedScp: string | null | undefined
function scpBin(): string {
  if (cachedScp !== undefined) return cachedScp ?? 'scp'
  try {
    const out = execFileSync(process.env.SHELL || '/bin/bash', ['-lc', 'command -v scp'], {
      encoding: 'utf-8'
    }).trim()
    cachedScp = out || null
  } catch {
    cachedScp = null
  }
  if (!cachedScp) {
    for (const p of ['/usr/bin/scp', '/usr/local/bin/scp', '/opt/homebrew/bin/scp']) {
      try {
        execFileSync(p, ['-V'], { stdio: 'ignore' })
        cachedScp = p
        break
      } catch {
        // keep trying
      }
    }
  }
  return cachedScp ?? 'scp'
}

export class SshProjectManager {
  private conns = new Map<string, Conn>()
  private remoteHooks: RemoteHooks
  /** Per-manager counter mixed into each upload token so concurrent drops never collide. */
  private uploadSeq = 0
  /** Projects whose agent-status mirror was actually pushed — gates the disconnect cleanup so a
   *  transient folder-picker browse (never pushed) doesn't pay an extra rm round-trip. */
  private statusPushed = new Set<string>()
  private watchdog?: ReturnType<typeof setInterval>
  /** Re-entrancy guard: a tick mid-reconnect (slow host) must not stack a second revalidation. */
  private revalidating = false
  constructor(private r: Runners) {
    this.remoteHooks = new RemoteHooks({ run: r.run })
  }

  /**
   * Master watchdog. Nothing subscribes to the master process's death, and it can't: with
   * `ControlPersist` the real master daemonizes away from the child we spawned, and a network
   * change (no sleep event, so no powerMonitor 'resume' → `revalidateAll`) kills it with no
   * signal to us. Every child ssh then silently falls back to a direct connection — sessions
   * keep "working", so the dead master goes unnoticed while each 5s poll opens a fresh
   * TCP+auth connection (the ~72k-logins/day field report). The mux'd pty clients' exit-255
   * does fire the renderer's SshReconnector, but ptys respawned before the master is back up
   * land on direct fallback connections and never migrate. So: periodically re-run the
   * idempotent `connect()` per cached entry (via `revalidateAll`) — a live master costs one
   * mux'd `-O check`; a dead one gets the full re-establish (stale socket unlinked, master
   * respawned, 'reconnecting' status so the renderer flow engages). Interval is unref'd so it
   * never holds the process open; an empty conns map makes a tick a no-op.
   */
  startWatchdog(intervalMs = MASTER_WATCHDOG_MS): void {
    if (this.watchdog) return
    this.watchdog = setInterval(() => {
      if (this.revalidating || this.conns.size === 0) return
      this.revalidating = true
      void this.revalidateAll().finally(() => {
        this.revalidating = false
      })
    }, intervalMs)
    this.watchdog.unref?.()
  }

  stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = undefined
  }

  async connect(
    projectId: string,
    conn: SshConnection,
    remoteCwd?: string
  ): Promise<{
    controlPath: string
    hookEndpointPath?: string
    tmuxConfPath?: string
    remoteHome?: string
    claudeAutoPermissionMode?: boolean
    remoteClaudeVersion?: string | null
  }> {
    const existing = this.conns.get(projectId)
    if (existing) {
      // Verify the cached master is still alive before reusing it — a dropped/timed-out master
      // would otherwise leave us reusing a dead socket. If `-O check` fails, surface
      // `reconnecting`, drop the stale entry, and fall through to re-establish.
      const { code } = await this.r.run(checkMasterArgs(existing.conn, existing.controlPath))
      if (code === 0) {
        // Keep the remote git cwd current even on an idempotent reuse (the folder may have changed).
        // Guard against a later connect without remoteCwd clearing a known cwd.
        existing.remoteCwd = remoteCwd ?? existing.remoteCwd
        return {
          controlPath: existing.controlPath,
          hookEndpointPath: existing.hookEndpointPath,
          tmuxConfPath: existing.tmuxConfPath,
          remoteHome: existing.remoteHome,
          claudeAutoPermissionMode: existing.claudeAutoPermissionMode,
          remoteClaudeVersion: existing.remoteClaudeVersion
        }
      }
      this.r.onStatus({ projectId, status: 'reconnecting' })
      existing.master.kill()
      this.conns.delete(projectId)
    }
    const controlPath = controlPathFor(projectId)
    // Best-effort: the socket dir is a short, space-free home dir (~/.nodeterm/ssh-cm). If it can't
    // be made, the master/`-O check` loop below fails and we report an error status anyway.
    try {
      await fs.mkdir(path.dirname(controlPath), { recursive: true, mode: 0o700 })
    } catch {
      // ignore — keeps the manager unit-testable
    }
    this.r.onStatus({ projectId, status: 'connecting' })
    // A master socket FILE can outlive its process (app crash, `kill -9`, host sleep/resume — a
    // plain `kill()` on quit doesn't always let ssh unlink it). ssh's `ControlMaster=auto` REFUSES
    // to bind over an existing socket file ("ControlSocket … already exists, disabling
    // multiplexing"), so a leftover DEAD socket makes every `-O check` below fail and connect()
    // time out with a generic error — the "SSH connection error" a user sees with no cause. Only a
    // FRESH connect reaches here (an existing entry returned above), so any socket on disk is a
    // leftover: probe it once — a still-answering master is a live orphan (its `ControlPersist`
    // outlived us) → adopt it; a dead one gets unlinked so the fresh master can bind. The common
    // case (no leftover) skips straight to spawn with no extra round-trip.
    let master: Conn['master']
    let leftover = false
    // A reused live-orphan master (adopted just below) still holds the PREVIOUS app run's reverse
    // hook forward, bound to that run's now-dead hook port (`hookServer` picks a fresh ephemeral
    // port every launch). If the tunnel then fails to verify, we rebuild a fresh master (below):
    // this flag says the current master was inherited, so that rebuild only fires on the orphan path.
    let reusedOrphan = false
    try {
      leftover = (await fs.stat(controlPath)).isSocket()
    } catch {
      // absent → no leftover (the normal path)
    }
    if (leftover && (await this.r.run(checkMasterArgs(conn, controlPath))).code === 0) {
      // Live orphan: reuse it. `kill()` sends `-O exit` (what `disconnect` does anyway); the loop
      // below succeeds on its first `-O check` and runs the normal post-connect setup.
      reusedOrphan = true
      master = {
        kill: () => {
          void this.r.run(exitMasterArgs(conn, controlPath)).catch(() => {})
        },
        on: () => {}
      }
    } else {
      if (leftover) await fs.rm(controlPath, { force: true }).catch(() => {})
      master = this.r.spawnMaster(masterArgs(conn, controlPath))
    }
    this.conns.set(projectId, { conn, controlPath, master, remoteCwd })
    // Wait until the master answers `-O check`, retrying briefly.
    for (let i = 0; i < 50; i++) {
      const { code } = await this.r.run(checkMasterArgs(conn, controlPath))
      if (code === 0) {
        // Master is up. Best-effort remote hook setup (reverse tunnel + endpoint + install);
        // fail-open — a null result just means the remote agents run without hooks.
        let res = await this.remoteHooks.setup(projectId, conn, controlPath, this.r.getHook())
        // Fresh-launch-straight-to-SSH failure mode (field report: no RUNNING badges from remote
        // sessions until a reconnect): an ADOPTED live-orphan master carries the previous app run's
        // `-R <sock>:127.0.0.1:<oldPort>` reverse-hook forward. Its target port died with that run,
        // and sshd can keep serving the stale listener across our rm+rebind (the "two fds on one
        // sshd" `remote-hooks` notes), so `setup()`'s tunnel never verifies → it returns null → the
        // remote endpoint file is never written → every remote hook POST vanishes → dead status for
        // the whole session. A client-side forward-cancel can't reliably displace the leaked listener;
        // the certain cure is a FRESH master, whose predecessor's forwards sshd tears down on `-O exit`.
        // Rebuild once and retry — ONLY on the orphan+failure path, so a clean connect is untouched.
        if (!res && reusedOrphan) {
          await this.r.run(exitMasterArgs(conn, controlPath)).catch(() => {}) // drop the orphan + its forwards
          await fs.rm(controlPath, { force: true }).catch(() => {})
          reusedOrphan = false
          master = this.r.spawnMaster(masterArgs(conn, controlPath))
          this.conns.set(projectId, { conn, controlPath, master, remoteCwd })
          for (let j = 0; j < 50 && !res; j++) {
            if ((await this.r.run(checkMasterArgs(conn, controlPath))).code === 0) {
              res = await this.remoteHooks.setup(projectId, conn, controlPath, this.r.getHook())
              break
            }
            await new Promise((r) => setTimeout(r, 100))
          }
        }
        const hookEndpointPath = res?.endpointPath
        // Resolve the remote $HOME once and retain it (the hook setup above also learns it but
        // doesn't surface it). Phase 2b uses it to jail remote transcript reads. Fail-open: an
        // unresolved home just disables the remote context meter / subagent transcript / search.
        let remoteHome: string | undefined
        try {
          const r = await this.r.run(childArgs(conn, controlPath, 'printf %s "$HOME"'))
          if (r.code === 0 && r.stdout.trim()) remoteHome = r.stdout.trim()
        } catch {
          // fail-open
        }
        // Write nodeterm's remote tmux.conf + source it into the (warm) server, best-effort. The
        // tmux server only reads `-f` when it starts; source-file pushes the options into an
        // already-running server (warm reattach) so existing + new sessions get mouse/clipboard.
        let tmuxConfPath: string | undefined
        if (remoteHome) {
          const confPath = `${remoteHome}/.nodeterm/tmux.conf`
          try {
            const dir = `${remoteHome}/.nodeterm`
            // The runner RESOLVES (doesn't throw) on a non-zero remote exit, so the catch below
            // only guards a thrown error. Gate `tmuxConfPath` on the WRITE's exit code: a failed
            // write (mkdir perms, disk full, …) must leave it undefined so `remoteTmuxCommand`
            // never passes `-f <missing-conf>` (which makes tmux refuse to start → terminal dies).
            const w = await this.r.run(
              childArgs(conn, controlPath, `mkdir -p ${posixQuote(dir)} && cat > ${posixQuote(confPath)}`),
              remoteTmuxConf(50000)
            )
            if (w.code === 0) {
              // source-file is best-effort (pushes options into a warm server); ignore its result.
              await this.r.run(childArgs(conn, controlPath, `tmux -L ${RMT_TMUX_SOCKET} source-file ${posixQuote(confPath)}`))
              tmuxConfPath = confPath
            }
          } catch {
            /* fail-open: no conf → remote tmux uses host defaults */
          }
        }
        // Canvas control for remote agent nodes. Gated on BOTH the resolved home (every remote
        // path must be absolute) and a verified tunnel (`hookEndpointPath` is only set once
        // setup() proved the reverse forward reaches this app run) — installing a skill whose
        // endpoint answers nothing would have the agent retry a dead socket instead of reporting
        // canvas control as unavailable. Not awaited: it is several remote round-trips of pure
        // best-effort setup, and holding the connect on them would delay every terminal.
        if (remoteHome && hookEndpointPath) {
          void this.remoteHooks.installCanvasControl(conn, controlPath, remoteHome)
          void this.remoteHooks.installContextLink(conn, controlPath, remoteHome)
        }
        const entry = this.conns.get(projectId)
        if (entry) {
          entry.hookEndpointPath = hookEndpointPath
          entry.remoteHome = remoteHome
          entry.tmuxConfPath = tmuxConfPath
        }
        this.r.onStatus({ projectId, status: 'connected' })
        // Probe the REMOTE claude CLI once per connect — `--permission-mode auto` only exists in
        // >= 2.1.71 and the host's CLI may be older than the local one. NOT awaited: the answer is
        // only ever an optional flag, and the probe's login shell must not delay the connect (and
        // with it every terminal in the project). It pushes itself into the conn + renderer when
        // it lands; until then this project's Claude nodes launch with the bare command.
        // Swallow any rejection: this is a best-effort optional probe, and an unhandled rejection
        // in the main process is a hard crash (Node's default --unhandled-rejections=throw), not a
        // log line. Internals are already try/catch-guarded, but `this.r.onStatus` (IPC send) can
        // still throw if the window is torn down mid-probe — that must never surface here.
        if (entry) void this.probeClaudeAutoPermissionMode(projectId, entry).catch(() => {})
        return {
          controlPath,
          hookEndpointPath,
          tmuxConfPath,
          remoteHome,
          claudeAutoPermissionMode: entry?.claudeAutoPermissionMode,
          remoteClaudeVersion: entry?.remoteClaudeVersion
        }
      }
      await new Promise((res) => setTimeout(res, 100))
    }
    // Capture the master's real ssh error BEFORE disconnect tears it down — that stderr
    // ("Permission denied (publickey)", "Could not resolve hostname", "Host key verification
    // failed", …) is the actual cause, and is otherwise thrown away by the master's ignored stdio.
    const stderr = master.stderr?.().trim()
    await this.disconnect(projectId)
    const detail = stderr ? lastSshErrorLine(stderr) : undefined
    const message = detail
      ? `Could not establish the SSH connection: ${detail}`
      : 'Could not establish the SSH connection.'
    this.r.onStatus({ projectId, status: 'error', error: message })
    throw new Error(message)
  }

  async listDir(projectId: string, dir: string): Promise<{ path: string; dirs: string[] }> {
    const c = this.conns.get(projectId)
    if (!c) throw new Error('Not connected.')
    const { stdout } = await this.r.run(listDirArgs(c.conn, c.controlPath, dir))
    return { path: dir, dirs: parseLsDirs(stdout) }
  }

  /** Create a remote directory (mkdir -p). Returns false when not connected or the mkdir fails. */
  async makeDir(projectId: string, dir: string): Promise<boolean> {
    const c = this.conns.get(projectId)
    if (!c) return false
    const { code } = await this.r.run(mkDirArgs(c.conn, c.controlPath, dir))
    return code === 0
  }

  /** Upload a local file to the remote over the master; returns the ABSOLUTE remote path, or null. */
  async uploadFile(projectId: string, localPath: string, fileName: string): Promise<string | null> {
    const c = this.conns.get(projectId)
    if (!c) return null
    // `localPath` is a renderer string passed straight to scp as a positional arg. A value starting
    // with `-` (e.g. `-oProxyCommand=…`) would be parsed by scp as an OPTION (argv flag smuggling →
    // RCE), not a file. A real OS file drop is always an absolute path, so require one here — this
    // rejects `-`-prefixed, relative, and empty paths and fully closes the flag-smuggling vector.
    if (!localPath.startsWith('/')) return null
    try {
      let home = c.remoteHome
      if (!home) {
        const r = await this.r.run(childArgs(c.conn, c.controlPath, 'printf %s "$HOME"'))
        if (r.code === 0 && r.stdout.trim()) home = r.stdout.trim()
      }
      if (!home) return null
      const token = `${Date.now().toString(36)}${(this.uploadSeq++).toString(36)}`
      const dir = `${home}/.nodeterm/uploads/${token}`
      const mk = await this.r.run(childArgs(c.conn, c.controlPath, `mkdir -p ${posixQuote(dir)}`))
      if (mk.code !== 0) return null
      // `fileName` is a renderer string: posixQuote blocks shell injection but NOT filesystem
      // traversal (e.g. `../../../.bashrc` would escape the token dir and overwrite a remote file).
      // Basename it in main before building the write path — never trust it for a write target.
      const safe = path.posix.basename(fileName)
      if (!safe || safe === '.' || safe === '..') return null
      const remotePath = `${dir}/${safe}`
      const up = await this.r.runScp(scpArgs(c.conn, c.controlPath, localPath, remotePath))
      return up.code === 0 ? remotePath : null
    } catch {
      return null
    }
  }

  /**
   * Pull a remote file (or directory tree) down to `destDir` over the project's ControlMaster —
   * the mirror of `uploadFile`, and what the Explorer's Download action runs on an SSH project.
   *
   * Three things carry the safety here:
   *  - **The local path is ours.** `destDir` is supplied by main (`app.getPath('downloads')` or a
   *    folder the user picked in a native dialog); the renderer only names the REMOTE side, and
   *    that name is basenamed + sanitized (`safeDownloadBasename`) before it is joined. So no
   *    renderer string can steer the write, and `..` can never appear as a component.
   *  - **Nothing existing is overwritten.** A collision takes the next `name (n)` candidate.
   *  - **A failed transfer leaves no half-file under the real name.** scp writes to `<name>.part`
   *    (a `.part` DIRECTORY for `-r`) and it is renamed into place only on exit 0 — the same
   *    write-then-rename discipline `sshWriteArgs` uses remotely. A failure unlinks the remains.
   */
  async downloadFile(projectId: string, remotePath: string, destDir: string): Promise<DownloadResult> {
    const c = this.conns.get(projectId)
    if (!c) return { ok: false, error: 'Not connected.' }
    const name = safeDownloadBasename(remotePath)
    if (!name) return { ok: false, error: 'That path cannot be downloaded.' }
    try {
      // Ask the REMOTE whether this is a directory rather than trusting the renderer's tree state:
      // it decides `-r`, and the tree can be stale. A failed probe is not evidence of "file" —
      // but `test -d` failing on a live master overwhelmingly means "not a directory", and the
      // worst case of guessing wrong is a plain scp error, so this stays fail-open.
      const probe = await this.r.run(childArgs(c.conn, c.controlPath, `test -d ${quoteRemotePath(remotePath)}`))
      const isDir = probe.code === 0
      await fs.mkdir(destDir, { recursive: true })
      const finalPath = await this.freeDestPath(destDir, name)
      const partPath = `${finalPath}.part`
      await fs.rm(partPath, { recursive: true, force: true }).catch(() => {})
      const res = await this.r.runScp(scpDownArgs(c.conn, c.controlPath, remotePath, partPath, isDir))
      if (res.code !== 0) {
        await fs.rm(partPath, { recursive: true, force: true }).catch(() => {})
        return { ok: false, error: 'The transfer failed. Is the file still there, and readable?' }
      }
      await fs.rename(partPath, finalPath)
      return { ok: true, localPath: finalPath, dir: isDir }
    } catch {
      return { ok: false, error: 'The download could not be completed.' }
    }
  }

  /** First `<dir>/<name>` variant that exists neither as the target nor as a leftover `.part`. */
  private async freeDestPath(destDir: string, name: string): Promise<string> {
    for (let attempt = 1; attempt <= DOWNLOAD_NAME_ATTEMPTS; attempt++) {
      const candidate = path.join(destDir, candidateName(name, attempt))
      const taken = await fs
        .access(candidate)
        .then(() => true)
        .catch(() => false)
      if (!taken) return candidate
    }
    // Every readable variant is taken: fall back to a stamped name rather than overwriting one.
    return path.join(destDir, candidateName(name, Date.now()))
  }

  /**
   * Authoritatively end the given nodes' REMOTE tmux sessions over the project's live master.
   * Called on project delete BEFORE disconnect, so the remote `nt-<id>` sessions are killed
   * regardless of whether the nodes were mounted (only the active project's nodes are). `nodeIds`
   * are raw node ids; we map each to its `nt-<id>` session name (the same name `spawnSession` /
   * `remoteTmuxHasSessionArgs` use). Best-effort per id — a missing session is ignored.
   */
  async killSessions(projectId: string, nodeIds: string[]): Promise<void> {
    const c = this.conns.get(projectId)
    if (!c) return
    await Promise.all(
      nodeIds.map((id) =>
        this.r.run(remoteTmuxKillArgs(c.conn, c.controlPath, sessionName(id))).then(
          () => undefined,
          () => undefined
        )
      )
    )
  }

  /**
   * The async ssh runner the manager uses, exposed so the Phase-2b remote transcript tails /
   * search read over the SAME ControlMaster. `args` are full ssh child args (e.g. from
   * `childArgs(conn, controlPath, cmd)`); returns `{ code, stdout }`.
   */
  sshRun(args: string[], stdin?: string): Promise<{ code: number; stdout: string }> {
    return this.r.run(args, stdin)
  }

  /**
   * Resolve the `{ conn, controlPath }` ref for a connected project (the `SshFsRef` shape Phase 3's
   * SshFs ops take). Returns `undefined` when the project isn't connected, so the `sshFs:*` IPC
   * handlers can fail open (empty result) rather than throw.
   */
  refForProject(
    projectId: string
  ): { conn: SshConnection; controlPath: string; remoteCwd?: string } | undefined {
    const c = this.conns.get(projectId)
    return c ? { conn: c.conn, controlPath: c.controlPath, remoteCwd: c.remoteCwd } : undefined
  }

  /**
   * Resolve the `{ conn, controlPath }` ref for the connected project whose remote repo cwd matches
   * `cwd` (Phase 4). Backs the git-remote resolver registry so remote git ops route to the right
   * master by working directory. Returns `undefined` when no connected project owns that cwd.
   */
  refForRemoteCwd(cwd: string): { conn: SshConnection; controlPath: string } | undefined {
    for (const c of this.conns.values()) {
      if (c.remoteCwd && c.remoteCwd === cwd) return { conn: c.conn, controlPath: c.controlPath }
    }
    return undefined
  }

  /** The resolved remote `$HOME` for a connected project, if known. */
  remoteHomeFor(projectId: string): string | undefined {
    return this.conns.get(projectId)?.remoteHome
  }

  /**
   * Proactively re-validate every cached master (powerMonitor 'resume'). Sleep kills the TCP
   * under the masters, but ServerAlive only notices ~60s AFTER wake — until then every terminal
   * looks alive and is dead (keys echo nothing, scroll does nothing). `connect()` is idempotent:
   * a live master returns immediately; a dead one is killed — which tears down its mux'd
   * per-terminal ssh clients too, so their exit-255 drops fire the renderer's SshReconnector
   * NOW instead of a minute later — and re-established, after which the reconnector's
   * 'connected' flush respawns the dead nodes. Failures just leave the normal status-event
   * error path in charge (connect reports it before throwing).
   */
  async revalidateAll(): Promise<void> {
    for (const [projectId, e] of [...this.conns]) {
      try {
        await this.connect(projectId, e.conn, e.remoteCwd)
      } catch {
        // connect() already reported an error status for this project; keep checking the rest.
      }
    }
  }

  /** The connection's cached remote `--permission-mode auto` capability (undefined = not
   *  probed / not connected). Feeds the agent-status settings block the phone reads. */
  remoteAutoPermFor(projectId: string): boolean | undefined {
    return this.conns.get(projectId)?.claudeAutoPermissionMode
  }

  /** `user@host` key of a connected project (matches ClaudeAccount.host). */
  hostKeyFor(projectId: string): string | undefined {
    const c = this.conns.get(projectId)
    return c ? sshHostKey(c.conn) : undefined
  }

  /** Remote path of this project's pushed agent-status mirror (`~`-relative when the remote
   *  home never resolved — the shell expands it in the commands below). */
  private statusFilePath(projectId: string, c: Conn): string {
    const dir = c.remoteHome ? `${c.remoteHome}/.nodeterm` : '~/.nodeterm'
    return `${dir}/agent-status-${projectId}.json`
  }

  /**
   * Mirror this project's slice of the agent-status doc onto its host as
   * `~/.nodeterm/agent-status-<projectId>.json` (atomic tmp+mv, 0600 via umask). This is the
   * ONLY status source that exists on an SSH host — hook events tunnel from the host to the
   * desktop's loopback hook server — so it's what the mobile companion reads when it browses
   * the host directly. No-ops when the project isn't connected; best-effort otherwise (a failed
   * write only means stale/absent badges on the phone).
   */
  async pushAgentStatus(projectId: string, json: string): Promise<void> {
    const c = this.conns.get(projectId)
    if (!c) return
    const file = this.statusFilePath(projectId, c)
    const q = quoteRemotePath(file)
    const qTmp = quoteRemotePath(`${file}.tmp`)
    this.statusPushed.add(projectId)
    await this.r
      .run(
        childArgs(
          c.conn,
          c.controlPath,
          `umask 077; mkdir -p ${quoteRemotePath(file.slice(0, file.lastIndexOf('/')))} && cat > ${qTmp} && mv -f ${qTmp} ${q}`
        ),
        json
      )
      .catch(() => {})
  }

  /**
   * Sweep phone read-acks on the connected hosts (spec: cross-surface read sync). The phone drops
   * `~/.nodeterm/acks/<nodeId>.seen` on the host it can reach; for a Mac→SSH node that host is the
   * REMOTE one, so the desktop must consume them over the ControlMaster — the local-fs sweep never
   * sees them. One command per connected HOST (deduped by host key, since projects sharing a host
   * share `$HOME/.nodeterm/acks`) atomically lists + deletes each `.seen` and prints its nodeId; the
   * returned ids are fed the SAME `ackDone` + unread-clear path a local ack takes. Best-effort — a
   * disconnected/failed project simply contributes nothing. The command is fully literal (no
   * interpolation), and the returned nodeIds are used only as in-memory map keys (never a path), so
   * a compromised host can at worst clear an unread badge / resolve a done card it can guess.
   */
  async sweepRemoteAcks(): Promise<string[]> {
    // List then delete each `~/.nodeterm/acks/*.seen`, printing the basename (nodeId). The `break` on
    // a non-existent first match handles the no-glob case (the pattern stays literal when nothing
    // matches). Absent dir ⇒ exit 0 (nothing swept).
    const cmd =
      'd="$HOME/.nodeterm/acks"; [ -d "$d" ] || exit 0; ' +
      'for f in "$d"/*.seen; do [ -e "$f" ] || break; ' +
      'printf "%s\\n" "$(basename "$f" .seen)"; rm -f "$f"; done'
    const seenHosts = new Set<string>()
    const out: string[] = []
    for (const c of this.conns.values()) {
      const hk = sshHostKey(c.conn)
      if (seenHosts.has(hk)) continue
      seenHosts.add(hk)
      try {
        const { code, stdout } = await this.r.run(childArgs(c.conn, c.controlPath, cmd))
        if (code === 0 && stdout) {
          for (const line of stdout.split('\n')) {
            const id = line.trim()
            if (id) out.push(id)
          }
        }
      } catch {
        // best-effort per host — a failed sweep just leaves the acks for the next tick
      }
    }
    return out
  }

  /**
   * Deterministic hook-reply approvals (docs/hook-reply-approvals.md): write the one-line answer
   * file for a held REMOTE permission hook, on the project's host over its ControlMaster (atomic
   * tmp+mv, 0600 via umask). The hook is polling `~/.nodeterm/pending/<pendingId>.answer` on that
   * host. `pendingId` is validated by the caller (main) before it reaches here; this method also
   * refuses anything but the safe charset as defense-in-depth, since it interpolates into a remote
   * shell command. No-ops (false) when the project isn't connected or the write fails.
   */
  async writePendingAnswer(
    projectId: string,
    pendingId: string,
    decision: 'allow' | 'deny'
  ): Promise<boolean> {
    const c = this.conns.get(projectId)
    if (!c) return false
    if (!/^[A-Za-z0-9_-]+$/.test(pendingId)) return false
    if (decision !== 'allow' && decision !== 'deny') return false
    const dir = c.remoteHome ? `${c.remoteHome}/.nodeterm/pending` : '~/.nodeterm/pending'
    const file = `${dir}/${pendingId}.answer`
    const q = quoteRemotePath(file)
    const qTmp = quoteRemotePath(`${file}.tmp`)
    const qDir = quoteRemotePath(dir)
    const { code } = await this.r
      .run(
        childArgs(
          c.conn,
          c.controlPath,
          `umask 077; mkdir -p ${qDir} && cat > ${qTmp} && mv -f ${qTmp} ${q}`
        ),
        decision
      )
      .catch(() => ({ code: 1, stdout: '' }))
    return code === 0
  }

  /**
   * The resolved remote `$HOME` for the project owning this `controlPath`, if known. The hook
   * raw-listener only has the node's `{ controlPath, conn }` (from `sshRemoteForNode`), so it
   * resolves the jail root by controlPath rather than projectId.
   */
  remoteHomeForControlPath(controlPath: string): string | undefined {
    for (const c of this.conns.values()) if (c.controlPath === controlPath) return c.remoteHome
    return undefined
  }

  // ── Managed REMOTE Claude accounts (Task 12) ──────────────────────────────────────────────
  // These run over the project's live master. Every op no-ops (null / silently) when the project
  // isn't connected, so the renderer's account list stays authoritative and fails open.

  /**
   * Create a managed remote account's config dir on the host and merge the status hook into its
   * `settings.json`. Returns the remote dir (`~/.nodeterm/claude-accounts/<id>`) + whether the
   * remote claude CLI is new enough to scope credentials per config dir, or null when not connected.
   */
  async remoteAccountAdd(
    projectId: string,
    accountId: string
  ): Promise<{ configDir: string; versionSupported: boolean } | null> {
    const c = this.conns.get(projectId)
    if (!c) return null
    const dir = remoteAccountConfigDir(accountId) // id-validated ~-relative path
    const mk = await this.r.run(mkDirArgs(c.conn, c.controlPath, dir))
    if (mk.code !== 0) return null
    // Install the managed hook into the account dir's settings.json (needs the absolute $HOME so the
    // merged `sh "…"` command has no unexpanded ~). Fail-open when the home never resolved.
    if (c.remoteHome) await this.remoteHooks.installIntoAccountDir(c.conn, c.controlPath, c.remoteHome, accountId)
    // Same gap for the canvas-control SKILL: claude resolves user skills relative to
    // CLAUDE_CONFIG_DIR, so an account session never sees the one in `~/.claude/skills`.
    if (c.remoteHome && c.hookEndpointPath) {
      await this.remoteHooks.installCanvasSkillIntoAccountDir(c.conn, c.controlPath, c.remoteHome, accountId)
      await this.remoteHooks.installContextLinkSkillIntoAccountDir(c.conn, c.controlPath, c.remoteHome, accountId)
    }
    // One remote `claude --version` gates both the keychain-scoping answer (>= 2.1, fail-open true)
    // AND the fullscreen-tui write (>= 2.1.89, write-if-absent) into the account dir.
    const version = await this.remoteClaudeVersion(c.conn, c.controlPath)
    if (c.remoteHome && supportsFullscreenTui(version)) {
      await this.remoteHooks.ensureFullscreenTuiInAccountDir(c.conn, c.controlPath, c.remoteHome, accountId)
    }
    return { configDir: dir, versionSupported: version ? isSupportedClaudeVersion(version) : true }
  }

  /** Read a managed remote account's `.claude.json` (login capture); null when not connected or the
   *  file isn't written yet. The renderer's waitLogin loop parses it with `parseLoginCapture`. */
  async remoteAccountReadLogin(projectId: string, accountId: string): Promise<string | null> {
    const c = this.conns.get(projectId)
    if (!c) return null
    const file = `${remoteAccountConfigDir(accountId)}/.claude.json`
    const { code, stdout } = await this.r.run(
      childArgs(c.conn, c.controlPath, `cat ${quoteRemotePath(file)} 2>/dev/null`)
    )
    return code === 0 && stdout ? stdout : null
  }

  /** Delete a managed remote account's config dir (`rm -rf`). No-op when not connected. The id is
   *  regex-validated and the prefix (`~/.nodeterm/claude-accounts/`) fixed, so no traversal. */
  async remoteAccountRemove(projectId: string, accountId: string): Promise<void> {
    const c = this.conns.get(projectId)
    if (!c) return
    const dir = remoteAccountConfigDir(accountId)
    await this.r.run(childArgs(c.conn, c.controlPath, `rm -rf ${quoteRemotePath(dir)}`))
  }

  /**
   * Best-effort `claude --version` ON THE REMOTE HOST. Null when it can't be determined.
   *
   * An ssh EXEC channel gets a non-interactive, non-login shell, whose rc file usually bails out
   * early — so a claude installed via nvm/asdf/homebrew-on-PATH may be invisible to a plain
   * `claude --version`. The remote tmux session that actually RUNS the node uses a login shell, so
   * the probe tries that first and only then the bare command. A login shell also sources the
   * user's profile, whose STDOUT noise (banners, neofetch, …) would otherwise be parsed as the
   * version — hence the marker-delimited value (see `claude-version-probe.ts`).
   */
  private async remoteClaudeVersion(conn: SshConnection, controlPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.r.run(childArgs(conn, controlPath, claudeVersionProbeCommand()))
      // Markers absent ⇒ FAILED probe ⇒ null (unknown). Never scrape free-form stdout.
      return parseClaudeVersionProbe(stdout)
    } catch {
      return null
    }
  }

  /**
   * Probe the remote CLI's `--permission-mode auto` support AFTER the connect resolves, then push
   * the answer into the live conn + the renderer (a `connected` status event carrying it).
   *
   * Deliberately OFF the connect critical path: it runs `$SHELL -lc`, which sources nvm/conda/rbenv
   * inits — routinely hundreds of ms, sometimes seconds — and every remote terminal in the project
   * waits on connect. A node launched in the gap just omits the flag (the designed fail-open
   * fallback); the next launch, once the answer lands, gets `auto`.
   *
   * A FAILED attempt (no claude found) retries on a bounded backoff — a transient hiccup must not
   * disable `auto` until the next reconnect. EVERY attempt pushes its answer immediately (the
   * fail-open `false` first, a later success upgrading it): launch paths that wait on the first
   * answer (`ensureActivePermissionMode`) must never be held hostage by the retry tail. A definite
   * version — old or new — stops the retries: a CLI doesn't change under a live connection.
   */
  private async probeClaudeAutoPermissionMode(projectId: string, entry: Conn): Promise<void> {
    const delays = this.r.probeRetryDelaysMs ?? PROBE_RETRY_DELAYS_MS
    for (let attempt = 0; ; attempt++) {
      // One remote `claude --version` feeds BOTH version gates (permission-mode auto >= 2.1.71 and
      // fullscreen tui >= 2.1.89) — no second probe.
      const version = await this.remoteClaudeVersion(entry.conn, entry.controlPath)
      // Disconnected / reconnected (new Conn) while we probed → the answer belongs to a dead
      // connection; drop it rather than write it onto the new one.
      if (this.conns.get(projectId) !== entry) return
      const supported = supportsAutoPermissionMode(version)
      entry.claudeAutoPermissionMode = supported
      entry.remoteClaudeVersion = version
      this.r.onStatus({
        projectId,
        status: 'connected',
        claudeAutoPermissionMode: supported,
        remoteClaudeVersion: version
      })
      if (version !== null) {
        // Ensure Claude's fullscreen TUI on the host's ~/.claude/settings.json (write-if-absent),
        // so a remote Claude session behaves natively in the host's tmux. Gated on the same probed
        // version; fail-open inside RemoteHooks. Needs the resolved $HOME for an absolute path.
        if (entry.remoteHome && supportsFullscreenTui(version)) {
          await this.remoteHooks.ensureFullscreenTui(entry.conn, entry.controlPath, entry.remoteHome)
        }
        return
      }
      if (attempt >= delays.length) return
      await new Promise((r) => setTimeout(r, delays[attempt]))
      if (this.conns.get(projectId) !== entry) return
    }
  }

  async disconnect(projectId: string): Promise<void> {
    const c = this.conns.get(projectId)
    if (!c) return
    // Remove the pushed agent-status mirror while the master is still alive: a file left behind
    // would freeze the phone's badges at the last event (the heartbeat that lets the phone detect
    // staleness dies with this connection). Best-effort.
    if (this.statusPushed.delete(projectId)) {
      const f = this.statusFilePath(projectId, c)
      await this.r
        .run(childArgs(c.conn, c.controlPath, `rm -f ${quoteRemotePath(f)} ${quoteRemotePath(`${f}.tmp`)}`))
        .catch(() => {})
    }
    // Cancel the reverse hook tunnel (over the still-live master) BEFORE tearing the master down.
    await this.remoteHooks.teardown(projectId, c.conn, c.controlPath)
    void this.r.run(exitMasterArgs(c.conn, c.controlPath))
    c.master.kill()
    this.conns.delete(projectId)
    this.r.onStatus({ projectId, status: 'disconnected' })
  }

  /**
   * Tear down every live master (on app quit) so no `-N` master ssh child is orphaned.
   * This MUST be synchronous: `before-quit` (index.ts) is sync and the process can exit before
   * any awaited work runs. `disconnect()` awaits an `ssh -O cancel` round-trip BEFORE killing the
   * master, so on a hard quit `c.master.kill()` would never run → orphaned `-N` master (~5 min
   * ControlPersist). Here we kill the master immediately and skip the graceful `-O cancel`: the
   * reverse hook forward dies with the master, so cancelling it is unnecessary on quit.
   */
  disconnectAll(): void {
    this.stopWatchdog()
    for (const projectId of [...this.conns.keys()]) {
      const c = this.conns.get(projectId)
      if (!c) continue
      c.master.kill()
      this.conns.delete(projectId)
      this.r.onStatus({ projectId, status: 'disconnected' })
    }
  }
}

export function initSshProject(
  win: BrowserWindow,
  onConnected?: (projectId: string) => void
): SshProjectManager {
  const ssh = sshBin()
  const scp = scpBin()
  const mgr = new SshProjectManager({
    userDataDir: app.getPath('userData'),
    spawnMaster: (args) => {
      // Capture the master's stderr (stdin/stdout stay ignored) so a failed connect can report the
      // real ssh error instead of a generic timeout. Buffer is capped so a chatty host can't grow it
      // unbounded; the master is long-lived and mostly silent, so this holds only the connect-time
      // diagnostics we actually want.
      const child = spawn(ssh, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < MASTER_STDERR_CAP) stderr += chunk.toString('utf-8')
      })
      // A spawn failure (ssh binary missing/unexecutable) surfaces on 'error' — fold it into the
      // same stderr channel so the connect error still has a cause. Prevents an unhandled 'error'.
      child.on('error', (e: Error) => {
        if (stderr.length < MASTER_STDERR_CAP) stderr += `${e.message}\n`
      })
      return { kill: () => child.kill(), on: (ev, cb) => child.on(ev, cb), stderr: () => stderr }
    },
    run: (args, stdin) =>
      new Promise((resolve) => {
        // 16 MB ceiling: remote transcript reads pull up to REMOTE_TRANSCRIPT_CAP (5 MB) via
        // RemoteFile; the default 1 MB maxBuffer would kill the child and silently break the
        // remote context meter / subagent transcript / content search for large transcripts.
        // (cf. pty-manager tmux capture 50 MB, git-service 20–50 MB.) Just a ceiling — safe for
        // the small Phase-1/2a control commands too.
        const child = execFile(ssh, args, { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: stdout ?? '' })
        )
        if (stdin !== undefined) {
          child.stdin?.end(stdin)
        }
      }),
    runScp: (args) =>
      new Promise((resolve) => {
        execFile(scp, args, { maxBuffer: 1024 * 1024 }, (err) => resolve({ code: err ? 1 : 0 }))
      }),
    getHook: () => ({ port: hookServer.getPort(), token: hookServer.getToken(), version: hookServer.getVersion() }),
    onStatus: (e) => {
      if (!win.isDestroyed()) win.webContents.send(IPC.sshProjectStatus, e)
    }
  })
  mgr.startWatchdog()
  ipcMain.handle(IPC.sshConnectProject, async (_e, projectId: string, conn: SshConnection, remoteCwd?: string) => {
    const res = await mgr.connect(projectId, conn, remoteCwd)
    // Connection is up (master in the map) → reconcile the remote project file with our cache.
    // Only fires on a successful connect; a throw above propagates without calling back.
    onConnected?.(projectId)
    return res
  })
  ipcMain.handle(IPC.sshDisconnectProject, (_e, projectId: string) => mgr.disconnect(projectId))
  ipcMain.handle(IPC.sshKillSessions, (_e, projectId: string, nodeIds: string[]) =>
    mgr.killSessions(projectId, nodeIds)
  )
  ipcMain.handle(IPC.sshListDir, (_e, projectId: string, dir: string) => mgr.listDir(projectId, dir))
  ipcMain.handle(IPC.sshMkdir, (_e, projectId: string, dir: string) => mgr.makeDir(projectId, dir))
  ipcMain.handle(IPC.sshUploadFile, (_e, projectId: string, localPath: string, fileName: string) =>
    mgr.uploadFile(projectId, localPath, fileName)
  )
  // The DESTINATION is resolved here, in main: the OS Downloads folder unless the renderer passed
  // a directory the user picked in the native folder dialog. The renderer never gets to name an
  // arbitrary local write target for a remote payload.
  ipcMain.handle(IPC.sshDownloadFile, (_e, projectId: string, remotePath: string, destDir?: string) =>
    mgr.downloadFile(projectId, remotePath, destDir || app.getPath('downloads'))
  )
  return mgr
}
