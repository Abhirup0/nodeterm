import { watch, type FSWatcher } from 'fs'
import { promises as fs } from 'fs'

interface Opts {
  paths(): string[]
  isSelfWrite(filePath: string, content: string): boolean
  onExternalChange(filePath: string): void
  debounceMs?: number
}

/**
 * Watches each local ref's project.json for outside edits (git pull, file sync,
 * a teammate's commit). Self-writes are recognized by exact content match against
 * the store's last-written cache and ignored. Events are debounced per file —
 * editors and git often touch a file several times in quick succession.
 */
export class WorkspaceWatcher {
  private watchers = new Map<string, FSWatcher>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private opts: Opts) {}

  sync(): void {
    const want = new Set(this.opts.paths())
    for (const [p, w] of this.watchers) {
      if (!want.has(p)) {
        w.close()
        this.watchers.delete(p)
      }
    }
    for (const p of want) {
      if (this.watchers.has(p)) continue
      try {
        const w = watch(p, () => this.schedule(p))
        // A watcher error (file replaced by rename, dir removed) must not crash main.
        w.on('error', () => {
          w.close()
          this.watchers.delete(p)
        })
        this.watchers.set(p, w)
      } catch {
        /* file missing right now → unavailable path; next sync() retries */
      }
    }
  }

  private schedule(p: string): void {
    clearTimeout(this.timers.get(p))
    this.timers.set(p, setTimeout(() => void this.check(p), this.opts.debounceMs ?? 300))
  }

  private async check(p: string): Promise<void> {
    let content: string
    try {
      content = await fs.readFile(p, 'utf-8')
    } catch {
      return // transient (atomic rename in flight)
    }
    if (this.opts.isSelfWrite(p, content)) {
      // Atomic saves replace the inode — rewatch so future outside edits still fire.
      this.watchers.get(p)?.close()
      this.watchers.delete(p)
      this.sync()
      return
    }
    // Atomic saves replace the inode — rewatch so future edits still fire.
    this.watchers.get(p)?.close()
    this.watchers.delete(p)
    this.sync()
    this.opts.onExternalChange(p)
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }
}
