import { promises as fs, readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { app, ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import { parseSshConfig, type ParsedSshHost, type SshServer } from '../shared/ssh'

/**
 * Stores saved SSH servers in ssh-servers.json. Keeps a synchronous cache so reads are
 * immediate; writes are atomic (temp + rename). The file path is injectable for tests.
 */
export class SshStore {
  private cache: SshServer[] = []
  private readonly path: string
  /** Serializes flushes so concurrent un-awaited saves can't race on the shared temp file. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(filePath?: string) {
    this.path = filePath ?? path.join(app.getPath('userData'), 'ssh-servers.json')
    try {
      const raw = readFileSync(this.path, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) this.cache = parsed as SshServer[]
    } catch {
      this.cache = []
    }
  }

  list(): SshServer[] {
    return this.cache
  }

  save(server: SshServer): SshServer[] {
    const i = this.cache.findIndex((s) => s.id === server.id)
    if (i >= 0) this.cache[i] = server
    else this.cache.push(server)
    void this.flush()
    return this.cache
  }

  remove(id: string): SshServer[] {
    this.cache = this.cache.filter((s) => s.id !== id)
    void this.flush()
    return this.cache
  }

  private flush(): Promise<void> {
    // Snapshot the cache now; chain after any in-flight write so the shared temp
    // file is never written/renamed by two flushes at once.
    const snapshot = JSON.stringify(this.cache, null, 2)
    const tmp = `${this.path}.tmp`
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        // 0o600: this holds the user's SSH host inventory (hosts/users/identity-file paths) —
        // owner read/write only, not world-readable.
        await fs.writeFile(tmp, snapshot, { encoding: 'utf-8', mode: 0o600 })
        await fs.rename(tmp, this.path)
      })
    return this.writeChain
  }

  /** Parse the user's `~/.ssh/config` into importable hosts (empty if it doesn't exist). */
  async importCandidates(): Promise<ParsedSshHost[]> {
    try {
      const text = await fs.readFile(path.join(os.homedir(), '.ssh', 'config'), 'utf-8')
      return parseSshConfig(text)
    } catch {
      return []
    }
  }

  registerIpc(): void {
    ipcMain.handle(IPC.sshList, () => this.list())
    ipcMain.handle(IPC.sshSave, (_e, server: SshServer) => this.save(server))
    ipcMain.handle(IPC.sshDelete, (_e, id: string) => this.remove(id))
    ipcMain.handle(IPC.sshImport, () => this.importCandidates())
  }
}
