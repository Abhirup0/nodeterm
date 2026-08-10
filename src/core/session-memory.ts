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
import type { MemInfo } from '../shared/types'

export type { MemInfo }

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
 * below it (which is what the panel's `└ +N MCP` sub-line reports).
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
