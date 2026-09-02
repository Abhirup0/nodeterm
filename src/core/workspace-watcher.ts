import { watch, type FSWatcher } from 'fs'
import { promises as fs } from 'fs'

interface Opts {
  paths(): string[]
  isSelfWrite(filePath: string, content: string): boolean
  onExternalChange(filePath: string): void
  debounceMs?: number
}

/** Retry cadence for a rebind that could not attach because the name was momentarily absent.
 *  Bounded: a path that is simply gone (an unavailable ref) falls back to "next sync() retries",
 *  which is the behaviour this class always had for a path that never existed. */
const REARM_RETRY_MS = 120
const REARM_MAX_TRIES = 25

/**
 * Watches each local ref's project.json for outside edits (git pull, file sync,
 * a teammate's commit). Self-writes are recognized by exact content match against
 * the store's last-written cache and ignored. Events are debounced per file —
 * editors and git often touch a file several times in quick succession.
 *
 * A cwd-less canvas's data file (`userData/inline-projects/<id>.json`) is deliberately NOT watched:
 * nothing external edits it — no git pull, no teammate, no sync client aimed at userData — and the
 * only other writer is a second app instance, which is settled by the rev rule in
 * `WorkspaceStore.writeDataFile` rather than by a live reload. See the ref-kinds table in CLAUDE.md.
 */
export class WorkspaceWatcher {
  private watchers = new Map<string, FSWatcher>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private rearms = new Map<string, ReturnType<typeof setTimeout>>()
  private rearmTries = new Map<string, number>()

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
    // Re-arm FIRST, and unconditionally — before anything that can fail or return early.
    // Measured on Linux/inotify: a FILE-bound fs.watch follows the INODE, so it reports the first
    // `mv -f tmp project.json` and then nothing, ever again. The rebind after each event is what
    // keeps this watcher alive at all.
    //
    // It used to live at the bottom, duplicated into the self-write and outside-edit branches, so
    // a failed read returned before reaching either — and it did NOT even drop the dead watcher,
    // which left the map holding an entry that is deaf (its inode is gone) yet indistinguishable
    // from a live one, so every later sync() skipped the path. One unreadable moment (the
    // corrupt-file sideline rename project.json → project.json.corrupt-<ts>, a transient EACCES)
    // therefore made that project permanently blind to outside edits for the rest of the run —
    // including every session the phone registers over direct SSH.
    this.rearm(p)
    let content: string
    try {
      content = await fs.readFile(p, 'utf-8')
    } catch {
      return // transient (atomic rename in flight) — the watch is already re-armed
    }
    if (this.opts.isSelfWrite(p, content)) return
    this.opts.onExternalChange(p)
  }

  /** Close and re-open the watch on `p` (see `check`). When the name is momentarily absent — an
   *  atomic replace in flight, or the corrupt-file sideline before the fresh file lands — `watch`
   *  throws and nothing else would re-add the path (`sync()` only runs when the workspace itself
   *  changes), so a bounded retry finishes the job. */
  private rearm(p: string): void {
    this.watchers.get(p)?.close()
    this.watchers.delete(p)
    this.sync()
    if (this.watchers.has(p) || !this.opts.paths().includes(p)) {
      this.rearmTries.delete(p)
      return
    }
    const tries = (this.rearmTries.get(p) ?? 0) + 1
    if (tries > REARM_MAX_TRIES) {
      this.rearmTries.delete(p)
      return
    }
    this.rearmTries.set(p, tries)
    clearTimeout(this.rearms.get(p))
    this.rearms.set(
      p,
      setTimeout(() => {
        this.rearms.delete(p)
        this.rearm(p)
      }, REARM_RETRY_MS)
    )
  }

  dispose(): void {
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const t of this.rearms.values()) clearTimeout(t)
    this.rearms.clear()
    this.rearmTries.clear()
  }
}
