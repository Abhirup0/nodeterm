import fs from 'fs'
import path from 'path'
import { watch, type FSWatcher } from 'fs'
import { BOARD_LOG_TEXT_MAX, type BoardLogEntry } from '@shared/types'

// Re-exported so callers of this module (and its tests) can reach the cap alongside buildLine.
export { BOARD_LOG_TEXT_MAX }

// Append-only board history. Each project's board log lives beside its nodes at
// `<cwd>/.nodeterm/board-log.jsonl`, one JSON entry per line, oldest-first on disk. Local
// projects use node:fs directly; SSH projects go through an injected RemoteLogExec (the seam
// that keeps this file electron-free — the ssh command builders live in main/ssh-fs.ts). The
// pure line build/parse helpers are exported so the diff/renderer can reason about entries.

const LOG_DIR = '.nodeterm'
const LOG_FILE = 'board-log.jsonl'
const DEFAULT_CAP = 500

/** Clamp an entry's `text` to `BOARD_LOG_TEXT_MAX` chars (+ '…' when truncated). Returns the
 *  same entry when nothing changes, else a shallow copy with the shortened text. */
export function clampEntryText(entry: BoardLogEntry): BoardLogEntry {
  const { text } = entry
  if (typeof text !== 'string' || text.length <= BOARD_LOG_TEXT_MAX) return entry
  return { ...entry, text: text.slice(0, BOARD_LOG_TEXT_MAX) + '…' }
}
// `all` still needs a finite tail count for the remote path; larger than any realistic log.
const ALL_LINES = 1_000_000_000

export interface ParseOpts {
  cap?: number
  all?: boolean
}

/** Remote (SSH) log I/O, injected so core stays electron-free. `line` has no trailing newline
 *  (the remote `printf '%s\n'` adds it); `tail` returns the last `lines` lines, oldest-first. */
export interface RemoteLogExec {
  append(path: string, line: string): Promise<void>
  tail(path: string, lines: number): Promise<string>
}

/** True when `x` is a structurally-valid BoardLogEntry. Tolerant callers use it to skip
 *  corrupt/foreign lines rather than throwing the whole log away. */
export function validEntry(x: unknown): x is BoardLogEntry {
  if (!x || typeof x !== 'object') return false
  const e = x as Record<string, unknown>
  if (typeof e.id !== 'string' || typeof e.ts !== 'number') return false
  const a = e.author as Record<string, unknown> | undefined
  if (!a || typeof a !== 'object' || typeof a.name !== 'string' || typeof a.color !== 'string') return false
  if (e.kind !== 'comment' && e.kind !== 'event') return false
  if (e.nodeId !== undefined && typeof e.nodeId !== 'string') return false
  if (e.text !== undefined && typeof e.text !== 'string') return false
  if (e.event !== undefined && (typeof e.event !== 'object' || e.event === null)) return false
  return true
}

/** One log line: single-line JSON + '\n'. Any newline in `text` is JSON-escaped, so the line
 *  never breaks the one-entry-per-line invariant. */
export function buildLine(entry: BoardLogEntry): string {
  return JSON.stringify(clampEntryText(entry)) + '\n'
}

/** Parse a raw log blob → entries, NEWEST-FIRST. Tolerant: lines that fail JSON.parse or the
 *  shape check are skipped. Capped at `cap` (default 500) unless `all` is set. */
export function parseLines(raw: string, opts: ParseOpts = {}): BoardLogEntry[] {
  const out: BoardLogEntry[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let obj: unknown
    try {
      obj = JSON.parse(t)
    } catch {
      continue
    }
    if (validEntry(obj)) out.push(obj)
  }
  out.reverse() // disk is oldest-first; callers want newest-first
  if (opts.all) return out
  return out.slice(0, opts.cap ?? DEFAULT_CAP)
}

function posixJoin(cwd: string, ...parts: string[]): string {
  return [cwd.replace(/\/+$/, ''), ...parts].join('/')
}

/** The remote (POSIX) path of a project's board log under `cwd`. Exported so the desktop SSH
 *  change-poll can fingerprint the same file the store's RemoteLogExec reads/writes. */
export function boardLogRemotePath(cwd: string): string {
  return posixJoin(cwd, LOG_DIR, LOG_FILE)
}

export class BoardLogStore {
  private remote?: RemoteLogExec
  constructor(opts: { remote?: RemoteLogExec }) {
    this.remote = opts.remote
  }

  private localPath(cwd: string): string {
    return path.join(cwd, LOG_DIR, LOG_FILE)
  }
  private remotePath(cwd: string): string {
    return boardLogRemotePath(cwd)
  }

  /** Append one entry. Fire-and-forget-safe: never throws — returns false on any fs/exec error. */
  async append(cwd: string, entry: BoardLogEntry): Promise<boolean> {
    const line = buildLine(entry)
    if (this.remote) {
      try {
        await this.remote.append(this.remotePath(cwd), line.replace(/\n$/, ''))
        return true
      } catch {
        return false
      }
    }
    try {
      fs.mkdirSync(path.join(cwd, LOG_DIR), { recursive: true })
      fs.appendFileSync(this.localPath(cwd), line)
      return true
    } catch {
      return false
    }
  }

  /** Read the log, newest-first (see parseLines). Missing file / failed read → []. */
  async read(cwd: string, opts: ParseOpts = {}): Promise<BoardLogEntry[]> {
    if (this.remote) {
      try {
        const raw = await this.remote.tail(this.remotePath(cwd), opts.all ? ALL_LINES : opts.cap ?? DEFAULT_CAP)
        return parseLines(raw, opts)
      } catch {
        return []
      }
    }
    let raw: string
    try {
      raw = await fs.promises.readFile(this.localPath(cwd), 'utf-8')
    } catch {
      return []
    }
    return parseLines(raw, opts)
  }

  /** Watch the log for changes; `cb` fires (debounced 250ms) on each change. Returns an unsub.
   *  Watches the `.nodeterm` dir (tolerant of the log file not existing yet); remote → no-op. */
  watch(cwd: string, cb: () => void): () => void {
    if (this.remote) return () => {}
    const dir = path.join(cwd, LOG_DIR)
    let timer: ReturnType<typeof setTimeout> | undefined
    let watcher: FSWatcher
    try {
      watcher = watch(dir, (_event, filename) => {
        if (filename && filename !== LOG_FILE) return
        clearTimeout(timer)
        timer = setTimeout(cb, 250)
      })
      watcher.on('error', () => {})
    } catch {
      return () => {}
    }
    return () => {
      clearTimeout(timer)
      watcher.close()
    }
  }
}
