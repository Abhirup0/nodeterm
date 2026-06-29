import { promises as fs } from 'fs'
import path from 'path'
import { spawn, execFile, execFileSync } from 'child_process'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import { parseLsDirs, type SshConnection } from '../../shared/ssh'
import type { SshProjectStatus } from '../../shared/types'
import {
  controlPathFor,
  masterArgs,
  listDirArgs,
  exitMasterArgs,
  checkMasterArgs,
  remoteTmuxKillArgs,
  childArgs
} from './control-master'
import { RemoteHooks } from './remote-hooks'
import { hookServer } from '../agents/hook-server'
import { sessionName } from '../tmux-naming'

interface Runners {
  userDataDir: string
  /** Spawn the long-lived master; returns a handle we can kill. */
  spawnMaster: (args: string[]) => { kill: () => void; on: (ev: string, cb: (...a: unknown[]) => void) => void }
  /** Run a one-shot ssh, resolving its stdout + exit code; optional stdin written to the child. */
  run: (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>
  /** Live loopback hook-server coordinates (injected so the manager stays testable). */
  getHook: () => { port: number; token: string; version: string }
  onStatus: (e: { projectId: string; status: SshProjectStatus; error?: string }) => void
}

interface Conn {
  conn: SshConnection
  controlPath: string
  master: ReturnType<Runners['spawnMaster']>
  hookEndpointPath?: string
  /** The remote `$HOME`, resolved at connect. Used (Phase 2b) to jail remote transcript reads
   * under `<remoteHome>/.claude/projects`. Undefined if it couldn't be resolved (fail-open). */
  remoteHome?: string
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

export class SshProjectManager {
  private conns = new Map<string, Conn>()
  private remoteHooks: RemoteHooks
  constructor(private r: Runners) {
    this.remoteHooks = new RemoteHooks({ run: r.run })
  }

  async connect(
    projectId: string,
    conn: SshConnection
  ): Promise<{ controlPath: string; hookEndpointPath?: string }> {
    const existing = this.conns.get(projectId)
    if (existing) {
      // Verify the cached master is still alive before reusing it — a dropped/timed-out master
      // would otherwise leave us reusing a dead socket. If `-O check` fails, surface
      // `reconnecting`, drop the stale entry, and fall through to re-establish.
      const { code } = await this.r.run(checkMasterArgs(existing.conn, existing.controlPath))
      if (code === 0) return { controlPath: existing.controlPath, hookEndpointPath: existing.hookEndpointPath }
      this.r.onStatus({ projectId, status: 'reconnecting' })
      existing.master.kill()
      this.conns.delete(projectId)
    }
    const controlPath = controlPathFor(this.r.userDataDir, projectId)
    // Best-effort: the socket dir lives under <userData> in production. If it can't be made,
    // the master/`-O check` loop below fails and we report an error status anyway.
    try {
      await fs.mkdir(path.dirname(controlPath), { recursive: true, mode: 0o700 })
    } catch {
      // ignore — keeps the manager unit-testable with a synthetic userDataDir
    }
    this.r.onStatus({ projectId, status: 'connecting' })
    const master = this.r.spawnMaster(masterArgs(conn, controlPath))
    this.conns.set(projectId, { conn, controlPath, master })
    // Wait until the master answers `-O check`, retrying briefly.
    for (let i = 0; i < 50; i++) {
      const { code } = await this.r.run(checkMasterArgs(conn, controlPath))
      if (code === 0) {
        // Master is up. Best-effort remote hook setup (reverse tunnel + endpoint + install);
        // fail-open — a null result just means the remote agents run without hooks.
        const res = await this.remoteHooks.setup(projectId, conn, controlPath, this.r.getHook())
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
        const entry = this.conns.get(projectId)
        if (entry) {
          entry.hookEndpointPath = hookEndpointPath
          entry.remoteHome = remoteHome
        }
        this.r.onStatus({ projectId, status: 'connected' })
        return { controlPath, hookEndpointPath }
      }
      await new Promise((res) => setTimeout(res, 100))
    }
    await this.disconnect(projectId)
    this.r.onStatus({ projectId, status: 'error', error: 'Could not establish the SSH connection.' })
    throw new Error('Could not establish the SSH connection.')
  }

  async listDir(projectId: string, dir: string): Promise<{ path: string; dirs: string[] }> {
    const c = this.conns.get(projectId)
    if (!c) throw new Error('Not connected.')
    const { stdout } = await this.r.run(listDirArgs(c.conn, c.controlPath, dir))
    return { path: dir, dirs: parseLsDirs(stdout) }
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
  refForProject(projectId: string): { conn: SshConnection; controlPath: string } | undefined {
    const c = this.conns.get(projectId)
    return c ? { conn: c.conn, controlPath: c.controlPath } : undefined
  }

  /** The resolved remote `$HOME` for a connected project, if known. */
  remoteHomeFor(projectId: string): string | undefined {
    return this.conns.get(projectId)?.remoteHome
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

  async disconnect(projectId: string): Promise<void> {
    const c = this.conns.get(projectId)
    if (!c) return
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
    for (const projectId of [...this.conns.keys()]) {
      const c = this.conns.get(projectId)
      if (!c) continue
      c.master.kill()
      this.conns.delete(projectId)
      this.r.onStatus({ projectId, status: 'disconnected' })
    }
  }
}

export function initSshProject(win: BrowserWindow): SshProjectManager {
  const ssh = sshBin()
  const mgr = new SshProjectManager({
    userDataDir: app.getPath('userData'),
    spawnMaster: (args) => spawn(ssh, args, { stdio: 'ignore' }),
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
    getHook: () => ({ port: hookServer.getPort(), token: hookServer.getToken(), version: hookServer.getVersion() }),
    onStatus: (e) => {
      if (!win.isDestroyed()) win.webContents.send(IPC.sshProjectStatus, e)
    }
  })
  ipcMain.handle(IPC.sshConnectProject, (_e, projectId: string, conn: SshConnection) =>
    mgr.connect(projectId, conn)
  )
  ipcMain.handle(IPC.sshDisconnectProject, (_e, projectId: string) => mgr.disconnect(projectId))
  ipcMain.handle(IPC.sshKillSessions, (_e, projectId: string, nodeIds: string[]) =>
    mgr.killSessions(projectId, nodeIds)
  )
  ipcMain.handle(IPC.sshListDir, (_e, projectId: string, dir: string) => mgr.listDir(projectId, dir))
  return mgr
}
