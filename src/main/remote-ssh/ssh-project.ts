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
  remoteTmuxKillArgs
} from './control-master'
import { sessionName } from '../tmux-naming'

interface Runners {
  userDataDir: string
  /** Spawn the long-lived master; returns a handle we can kill. */
  spawnMaster: (args: string[]) => { kill: () => void; on: (ev: string, cb: (...a: unknown[]) => void) => void }
  /** Run a one-shot ssh, resolving its stdout + exit code. */
  run: (args: string[]) => Promise<{ code: number; stdout: string }>
  onStatus: (e: { projectId: string; status: SshProjectStatus; error?: string }) => void
}

interface Conn {
  conn: SshConnection
  controlPath: string
  master: ReturnType<Runners['spawnMaster']>
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
  constructor(private r: Runners) {}

  async connect(projectId: string, conn: SshConnection): Promise<{ controlPath: string }> {
    const existing = this.conns.get(projectId)
    if (existing) {
      // Verify the cached master is still alive before reusing it — a dropped/timed-out master
      // would otherwise leave us reusing a dead socket. If `-O check` fails, surface
      // `reconnecting`, drop the stale entry, and fall through to re-establish.
      const { code } = await this.r.run(checkMasterArgs(existing.conn, existing.controlPath))
      if (code === 0) return { controlPath: existing.controlPath }
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
        this.r.onStatus({ projectId, status: 'connected' })
        return { controlPath }
      }
      await new Promise((res) => setTimeout(res, 100))
    }
    this.disconnect(projectId)
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

  disconnect(projectId: string): void {
    const c = this.conns.get(projectId)
    if (!c) return
    void this.r.run(exitMasterArgs(c.conn, c.controlPath))
    c.master.kill()
    this.conns.delete(projectId)
    this.r.onStatus({ projectId, status: 'disconnected' })
  }

  /** Tear down every live master (on app quit) so no `-N` master ssh child is orphaned. */
  disconnectAll(): void {
    for (const projectId of [...this.conns.keys()]) this.disconnect(projectId)
  }
}

export function initSshProject(win: BrowserWindow): SshProjectManager {
  const ssh = sshBin()
  const mgr = new SshProjectManager({
    userDataDir: app.getPath('userData'),
    spawnMaster: (args) => spawn(ssh, args, { stdio: 'ignore' }),
    run: (args) =>
      new Promise((resolve) =>
        execFile(ssh, args, { timeout: 15000 }, (err, stdout) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: stdout ?? '' })
        )
      ),
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
