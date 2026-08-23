import { execFile } from 'child_process'

/**
 * The `#{pane_current_command}` equivalent for a backend with no tmux underneath it. tmux tracks
 * this by watching the pane's foreground process GROUP; we have no such kernel hook here, so this
 * WALKS THE DESCENDANTS of the pty's own child pid and reports the deepest live one.
 *
 * This is a deliberately small, standalone reader rather than a reuse of
 * `src/core/session-memory.ts`'s process-table reader: that module queries `pid,ppid,rss` (for
 * memory accounting) and has no Windows branch at all yet, so there is nothing here to actually
 * reuse without querying a THIRD column (`comm`/`Name`) it does not fetch — this is the "cannot,
 * so wrote a second (much smaller) one" case CLAUDE.md's guidance for this task allows for.
 *
 * The in-place agent restart feature (CLAUDE.md, "Restart agent (resume)") only cares about ONE
 * distinction — "is a SHELL back in charge of this pane, or is something else still running" — so
 * imprecision below that bar (which of several MCP-server children counts as "the" foreground
 * process) is harmless: every non-shell answer reads the same way to that caller. Documented as a
 * known limitation in docs/windows-session-host.md rather than pretended away.
 */

interface ProcRow {
  pid: number
  ppid: number
  name: string
}

function indexRows(rows: readonly ProcRow[]): {
  table: Map<number, ProcRow>
  kids: Map<number, number[]>
} {
  const table = new Map<number, ProcRow>()
  const kids = new Map<number, number[]>()
  for (const r of rows) {
    table.set(r.pid, r)
    const list = kids.get(r.ppid)
    if (list) list.push(r.pid)
    else kids.set(r.ppid, [r.pid])
  }
  return { table, kids }
}

function readWin32(): Promise<ProcRow[]> {
  return new Promise((resolve) => {
    // -NoProfile/-NonInteractive: this runs unattended and can be polled every ~250ms while a
    // restart is in progress — sourcing a user PowerShell profile here would be exactly the
    // "100-800ms per lookup" mistake exec-path.ts documents for the POSIX login-shell PATH probe.
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'
      ],
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve([])
        try {
          const parsed = JSON.parse(stdout) as unknown
          const arr = Array.isArray(parsed) ? parsed : [parsed]
          const rows = arr
            .map((r) => {
              const o = r as { ProcessId?: unknown; ParentProcessId?: unknown; Name?: unknown }
              return { pid: Number(o.ProcessId), ppid: Number(o.ParentProcessId), name: String(o.Name ?? '') }
            })
            .filter((r) => Number.isFinite(r.pid) && Number.isFinite(r.ppid))
          resolve(rows)
        } catch {
          resolve([])
        }
      }
    )
  })
}

function readPosix(): Promise<ProcRow[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid,ppid,comm'], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve([])
      const rows: ProcRow[] = []
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
        if (!m) continue
        rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] })
      }
      resolve(rows)
    })
  })
}

/** The deepest live descendant of `rootPid` (the pty's own child), by name — or null when the
 *  process table couldn't be read or `rootPid` is no longer in it (the session just exited). */
export async function paneCommand(rootPid: number): Promise<string | null> {
  const rows = process.platform === 'win32' ? await readWin32() : await readPosix()
  if (rows.length === 0) return null
  const { table, kids } = indexRows(rows)
  if (!table.has(rootPid)) return null
  let deepest = rootPid
  const seen = new Set<number>([rootPid])
  const stack = [...(kids.get(rootPid) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    if (table.has(pid)) deepest = pid
    for (const k of kids.get(pid) ?? []) stack.push(k)
  }
  return table.get(deepest)?.name || null
}
