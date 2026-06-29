// SSH filesystem ops over a project's ControlMaster. The remote analog of fs-ops.ts: same
// fail-open contract ([]/''/false on any error), reused by the renderer's sshFs(projectId) FsApi.
// Every path is posixQuote'd; write content goes on stdin (never interpolated).
import { childArgs } from './remote-ssh/control-master'
import { posixQuote, type SshConnection } from '../shared/ssh'
import type { DirEntry } from '../shared/types'

export interface SshFsRef {
  conn: SshConnection
  controlPath: string
}
type Runner = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>

function dirname(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export function sshListArgs(conn: SshConnection, cp: string, path: string): string[] {
  return childArgs(conn, cp, `ls -Ap1 ${posixQuote(path)}`)
}
export function sshReadArgs(conn: SshConnection, cp: string, path: string): string[] {
  return childArgs(conn, cp, `cat ${posixQuote(path)}`)
}
export function sshReadBinaryArgs(conn: SshConnection, cp: string, path: string): string[] {
  return childArgs(conn, cp, `base64 ${posixQuote(path)}`)
}
export function sshWriteArgs(conn: SshConnection, cp: string, path: string): string[] {
  return childArgs(conn, cp, `mkdir -p ${posixQuote(dirname(path))} && cat > ${posixQuote(path)}`)
}
export function sshCheckIgnoreArgs(conn: SshConnection, cp: string, dir: string, names: string[]): string[] {
  return childArgs(conn, cp, `git -C ${posixQuote(dir)} check-ignore -- ${names.map(posixQuote).join(' ')}`)
}

/** Parse `ls -Ap1` output → DirEntry[]: trailing-slash = dir, hide .git, folders-first alpha. */
export function parseLsEntries(stdout: string): DirEntry[] {
  const entries: DirEntry[] = stdout
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l && l !== './' && l !== '../')
    .map((l) => (l.endsWith('/') ? { name: l.slice(0, -1), dir: true, ignored: false } : { name: l, dir: false, ignored: false }))
    .filter((e) => e.name !== '.git')
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  return entries
}

export class SshFs {
  constructor(private run: Runner) {}

  async listDir(ref: SshFsRef, path: string): Promise<DirEntry[]> {
    try {
      const { code, stdout } = await this.run(sshListArgs(ref.conn, ref.controlPath, path))
      if (code !== 0) return []
      const entries = parseLsEntries(stdout)
      if (entries.length) {
        try {
          const ci = await this.run(sshCheckIgnoreArgs(ref.conn, ref.controlPath, path, entries.map((e) => e.name)))
          const set = new Set(ci.stdout.split('\n').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean))
          for (const e of entries) if (set.has(e.name)) e.ignored = true
        } catch {
          /* check-ignore best-effort */
        }
      }
      return entries
    } catch {
      return []
    }
  }

  async readText(ref: SshFsRef, path: string): Promise<string> {
    try {
      const { code, stdout } = await this.run(sshReadArgs(ref.conn, ref.controlPath, path))
      return code === 0 ? stdout : ''
    } catch {
      return ''
    }
  }

  async readBinary(ref: SshFsRef, path: string): Promise<string> {
    try {
      const { code, stdout } = await this.run(sshReadBinaryArgs(ref.conn, ref.controlPath, path))
      return code === 0 ? stdout.replace(/\s+/g, '') : ''
    } catch {
      return ''
    }
  }

  async writeText(ref: SshFsRef, path: string, content: string): Promise<boolean> {
    try {
      const { code } = await this.run(sshWriteArgs(ref.conn, ref.controlPath, path), content)
      return code === 0
    } catch {
      return false
    }
  }
}
