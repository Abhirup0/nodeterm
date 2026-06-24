// Shared filesystem operations (main process).
//
// The single source of truth for the app's `fs.*` reads/writes. BOTH the local `fs:*` IPC
// handlers (`index.ts`, used by the local Explorer/Editor) AND the remote `fs.*` RPC handlers
// (`remote/host-service.ts`, used by a client's Explorer/Editor over the relay) call these, so
// the local and remote filesystem behaviour stay byte-for-byte identical (DRY).
//
// Each helper is error-tolerant by design: the renderer's `FsApi` contract treats failures as
// empty/false rather than throwing, so a missing file or unreadable dir degrades gracefully.

import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { DirEntry } from '../shared/types'

const run = promisify(execFile)

/**
 * List a directory: folders first then files (alphabetical), `.git` hidden, git-ignored entries
 * flagged so the explorer can dim them. Returns `[]` on any error.
 */
export async function listDir(dirPath: string): Promise<DirEntry[]> {
  try {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true })
    const entries: DirEntry[] = dirents
      .filter((e) => e.name !== '.git')
      .map((e) => ({ name: e.name, dir: e.isDirectory(), ignored: false }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))

    // Mark git-ignored entries (so the explorer can dim them).
    if (entries.length) {
      const flag = (out: string): void => {
        const set = new Set(
          out
            .split('\n')
            .map((s) => s.trim().replace(/\/$/, ''))
            .filter(Boolean)
        )
        for (const en of entries) if (set.has(en.name)) en.ignored = true
      }
      try {
        const { stdout } = await run(
          'git',
          ['-C', dirPath, 'check-ignore', '--', ...entries.map((e) => e.name)],
          { maxBuffer: 4 * 1024 * 1024 }
        )
        flag(stdout)
      } catch (err) {
        const out = (err as { stdout?: string }).stdout
        if (out) flag(out)
      }
    }
    return entries
  } catch {
    return []
  }
}

/** Read a file's UTF-8 text. Returns `''` on any error. */
export async function readText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/** Read a file as base64 (for image/binary previews). Returns `''` on any error. */
export async function readBinary(filePath: string): Promise<string> {
  try {
    const buf = await fs.readFile(filePath)
    return buf.toString('base64')
  } catch {
    return ''
  }
}

/** Write UTF-8 text to a file. Resolves `true` on success, `false` on any error. */
export async function writeText(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.writeFile(filePath, content, 'utf-8')
    return true
  } catch {
    return false
  }
}
