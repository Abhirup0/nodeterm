// Per-session memory accounting: which nt- tmux session is holding how much RSS, including the
// agent CLI's own children (MCP servers, headless browsers).
//
// The measurement a user actually asks about is the PROCESS TREE under a pane, not the pane's own
// process: a `claude` session is ~335 MB itself but routinely carries 30-200 MB of MCP children,
// and a report that named only the pane would understate it by a third.
//
// Electron-free (src/core): every fs/exec access is behind an injectable seam (template:
// session-budget.ts), so both shells boot it and tests drive it without touching /proc or tmux.

import fs from 'fs'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { MemInfo, SessionMemoryRow, SessionMemoryReport } from '../shared/types'
import { TMUX_SOCKET } from './tmux-naming'
import { RMT_TMUX_SOCKET } from './remote-ssh/control-master'

export type { MemInfo, SessionMemoryRow, SessionMemoryReport }

const runAsync = promisify(execFile)

/** One process from the host's table. `rssKb` is resident set size in kB. Core-internal: it never
 *  crosses the wire, so it does not belong in shared/types. */
export interface ProcEntry {
  pid: number
  ppid: number
  rssKb: number
}

/** Reads the whole process table at once; null when it could not run. */
export type ProcessTableReader = () => ProcEntry[] | null

const kbToMb = (kb: number): number => Math.round(kb / 1024)

/** Index a flat table into pid→entry plus ppid→children, so a tree walk is O(nodes). */
export function indexProcesses(entries: readonly ProcEntry[]): {
  table: Map<number, ProcEntry>
  kids: Map<number, number[]>
} {
  const table = new Map<number, ProcEntry>()
  const kids = new Map<number, number[]>()
  for (const e of entries) {
    table.set(e.pid, e)
    const list = kids.get(e.ppid)
    if (list) list.push(e.pid)
    else kids.set(e.ppid, [e.pid])
  }
  return { table, kids }
}

/**
 * Total RSS of `root` and every descendant, split into the pane's own process and everything
 * below it (which is what the panel's `└ +N child processes` sub-line reports).
 *
 * `childCount` counts EVERY descendant, the agent CLI included: `root` is the pane's SHELL, so a
 * claude session with two MCP servers reports 3, not 2. Labelling it `+N MCP` would be a lie.
 *
 * A `seen` set guards the walk: a process table captured while pids are being recycled can
 * present a cyclic ppid chain, and a sweep that hangs is worse than one that under-reports.
 */
export function rollupTree(
  table: ReadonlyMap<number, ProcEntry>,
  kids: ReadonlyMap<number, number[]>,
  root: number
): { selfMb: number; childrenMb: number; childCount: number; totalMb: number } {
  const self = table.get(root)
  if (!self) return { selfMb: 0, childrenMb: 0, childCount: 0, totalMb: 0 }
  let childrenKb = 0
  let childCount = 0
  const seen = new Set<number>([root])
  const stack = [...(kids.get(root) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    const e = table.get(pid)
    if (!e) continue
    childrenKb += e.rssKb
    childCount++
    for (const k of kids.get(pid) ?? []) stack.push(k)
  }
  const selfMb = kbToMb(self.rssKb)
  const childrenMb = kbToMb(childrenKb)
  return { selfMb, childrenMb, childCount, totalMb: selfMb + childrenMb }
}

/** Parse `ps -eo pid,ppid,rss` output. Tolerant: header and malformed lines are skipped. */
export function parseProcessTable(stdout: string): ProcEntry[] {
  const out: ProcEntry[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const pid = Number(parts[0])
    const ppid = Number(parts[1])
    const rssKb = Number(parts[2])
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rssKb)) continue
    out.push({ pid, ppid, rssKb })
  }
  return out
}

/** Linux `/proc/meminfo` (MemAvailable is the honest number); `os.freemem()` fallback elsewhere.
 *  Returns null when nothing is readable — callers treat that as "no signal", never as zero.
 *
 *  Lives here rather than in session-budget.ts because two features now read it (the reaper's
 *  watermark and the system-resource pill) and a second copy would drift. */
export function readMemInfo(): MemInfo | null {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8')
    const avail = /MemAvailable:\s+(\d+)\s*kB/.exec(text)
    const total = /MemTotal:\s+(\d+)\s*kB/.exec(text)
    if (avail && total) {
      return {
        availableMb: Math.round(Number(avail[1]) / 1024),
        totalMb: Math.round(Number(total[1]) / 1024)
      }
    }
  } catch {
    // fall through to the os fallback
  }
  try {
    return {
      availableMb: Math.round(os.freemem() / 1048576),
      totalMb: Math.round(os.totalmem() / 1048576)
    }
  } catch {
    return null
  }
}

/** One tmux pane as reported by `list-panes -a`. Core-internal. */
export interface PaneRef {
  session: string
  panePid: number
  command: string
}

const PANE_FMT = '#{session_name}|#{pane_pid}|#{pane_current_command}'

/** Parse `list-panes -a -F '<PANE_FMT>'`. Tolerant: malformed lines are skipped. */
export function parsePaneList(stdout: string): PaneRef[] {
  const out: PaneRef[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split('|')
    if (parts.length < 3) continue
    const panePid = Number(parts[1])
    if (!parts[0] || !Number.isFinite(panePid)) continue
    out.push({ session: parts[0], panePid, command: parts[2] })
  }
  return out
}

/** Pure assembly: panes + a process table → sorted rows. Only `nt-` sessions are ours. */
export function buildReport(
  panes: readonly PaneRef[],
  table: readonly ProcEntry[],
  mem: MemInfo | null
): SessionMemoryReport {
  const { table: byPid, kids } = indexProcesses(table)
  const rows: SessionMemoryRow[] = []
  for (const p of panes) {
    if (!p.session.startsWith('nt-')) continue
    const t = rollupTree(byPid, kids, p.panePid)
    rows.push({
      session: p.session,
      nodeId: p.session.slice('nt-'.length),
      panePid: p.panePid,
      command: p.command,
      ...t
    })
  }
  rows.sort((a, b) => b.totalMb - a.totalMb)
  return { ok: true, rows, mem }
}

export interface SessionMemoryDeps {
  /** Lazy tmux resolver (PtyManager resolves after init; null = tmux unavailable). */
  tmuxBin: () => string | null
  /** Sockets to sweep. Default: the local socket + the SSH-remote socket. */
  sockets?: string[]
  exec?: (bin: string, args: string[]) => Promise<string>
  readTable?: ProcessTableReader
  readMem?: () => MemInfo | null
}

/** Default reader: /proc on Linux (no subprocess), one `ps` call everywhere else. */
export function defaultProcessTableReader(): ProcEntry[] | null {
  if (process.platform === 'linux') {
    try {
      const out: ProcEntry[] = []
      for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue
        try {
          const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8')
          // The comm field is parenthesized and may contain spaces: split AFTER the last ')'.
          const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
          const ppid = Number(after[1])
          const statm = fs.readFileSync(`/proc/${name}/statm`, 'utf8').split(' ')
          const rssPages = Number(statm[1])
          if (!Number.isFinite(ppid) || !Number.isFinite(rssPages)) continue
          out.push({ pid: Number(name), ppid, rssKb: (rssPages * 4096) / 1024 })
        } catch {
          // The process exited between readdir and read — skip it, never fail the sweep.
        }
      }
      return out
    } catch {
      return null
    }
  }
  return null // non-Linux falls through to the ps path in collectSessionMemory
}

/**
 * One sweep. Failure rules (CLAUDE.md: a failed read is never evidence of absence):
 *  - no tmux binary, or an unreadable process table → `ok: false`, no rows;
 *  - a socket whose `list-panes` fails contributes NO panes but is NOT a failure — "no server
 *    running" is the normal answer for a socket nobody has used yet.
 */
export async function collectSessionMemory(
  deps: SessionMemoryDeps
): Promise<SessionMemoryReport> {
  const readMem = deps.readMem ?? readMemInfo
  const mem = readMem()
  const bin = deps.tmuxBin()
  if (!bin) return { ok: false, rows: [], mem }

  const exec =
    deps.exec ??
    (async (b: string, args: string[]): Promise<string> => {
      const { stdout } = await runAsync(b, args, { timeout: 15_000 })
      return stdout
    })

  const readTable =
    deps.readTable ??
    ((): ProcEntry[] | null => {
      const viaProc = defaultProcessTableReader()
      if (viaProc) return viaProc
      return null
    })

  let table = readTable()
  if (table === null && !deps.readTable) {
    // Non-Linux (or an unreadable /proc): one `ps` call for the whole table.
    try {
      const { stdout } = await runAsync('ps', ['-eo', 'pid,ppid,rss'], { timeout: 15_000 })
      table = parseProcessTable(stdout)
    } catch {
      table = null
    }
  }
  if (table === null) return { ok: false, rows: [], mem }

  const sockets = deps.sockets ?? [TMUX_SOCKET, RMT_TMUX_SOCKET]
  const bySession = new Map<string, PaneRef>()
  for (const s of sockets) {
    try {
      const stdout = await exec(bin, ['-L', s, 'list-panes', '-a', '-F', PANE_FMT])
      // First pane of a session wins: a session with several panes is still one row.
      for (const p of parsePaneList(stdout))
        if (!bySession.has(p.session)) bySession.set(p.session, p)
    } catch {
      // "no server running" and a real failure both land here; neither yields panes, and neither
      // makes the whole sweep a failure — the other socket may well have answered.
    }
  }
  return buildReport([...bySession.values()], table, mem)
}
