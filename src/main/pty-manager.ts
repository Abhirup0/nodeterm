import os from 'os'
import { ipcMain, webContents } from 'electron'
import * as pty from 'node-pty'
import { IPC } from '../shared/ipc'
import type { PtyCreateOptions } from '../shared/types'

interface Session {
  proc: pty.IPty
  /** The renderer we send output back to. */
  webContentsId: number
}

/**
 * Manages all live PTY processes and bridges them to the renderer over IPC.
 * The renderer never touches node-pty directly; everything goes through this class.
 */
export class PtyManager {
  private sessions = new Map<string, Session>()
  private counter = 0

  registerIpc(): void {
    ipcMain.handle(IPC.ptyCreate, (event, options: PtyCreateOptions) =>
      this.create(event.sender.id, options)
    )
    ipcMain.on(IPC.ptyWrite, (_event, sessionId: string, data: string) =>
      this.write(sessionId, data)
    )
    ipcMain.on(IPC.ptyResize, (_event, sessionId: string, cols: number, rows: number) =>
      this.resize(sessionId, cols, rows)
    )
    ipcMain.on(IPC.ptyKill, (_event, sessionId: string) => this.kill(sessionId))
  }

  private create(webContentsId: number, options: PtyCreateOptions): string {
    const sessionId = `pty-${++this.counter}`
    const shell =
      options.shell || process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash')

    const proc = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd || os.homedir(),
      env: process.env as Record<string, string>
    })

    proc.onData((data) => {
      this.send(webContentsId, IPC.ptyData(sessionId), data)
    })

    proc.onExit(({ exitCode }) => {
      this.send(webContentsId, IPC.ptyExit(sessionId), exitCode)
      this.sessions.delete(sessionId)
    })

    this.sessions.set(sessionId, { proc, webContentsId })
    return sessionId
  }

  private write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.proc.write(data)
  }

  private resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // cols/rows must be at least 1, otherwise node-pty throws.
    session.proc.resize(Math.max(1, cols), Math.max(1, rows))
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.proc.kill()
    this.sessions.delete(sessionId)
  }

  /** Terminate all processes when the app quits. */
  killAll(): void {
    for (const { proc } of this.sessions.values()) proc.kill()
    this.sessions.clear()
  }

  private send(webContentsId: number, channel: string, payload: unknown): void {
    const wc = webContents.fromId(webContentsId)
    if (wc && !wc.isDestroyed()) wc.send(channel, payload)
  }
}
