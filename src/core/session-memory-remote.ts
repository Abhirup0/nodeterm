// The SSH leg of session memory: an SSH project's sessions live on the HOST, so the sweep must
// happen there. Core generates one POSIX sh line, the shell runs it over the project's
// ControlMaster, and only the printed sections come back — the same division of labour as
// remote-claude-usage.ts (core owns the command AND the parsing; the shell owns the master).
//
// One round trip carries all three facts, because each extra `ssh` exec is a login on someone
// else's machine.

import {
  buildReport,
  parsePaneList,
  parseProcessTable,
  PANE_FMT,
  type MemInfo,
  type PaneRef,
  type SessionMemoryReport
} from './session-memory'
import { TMUX_SOCKET } from './tmux-naming'
import { RMT_TMUX_SOCKET } from './remote-ssh/control-master'

const MEM = '##MEM'
const PANES = '##PANES'
const PROCS = '##PROCS'

/**
 * The generated command. Notes that are load-bearing:
 *  - Every section header is printed unconditionally, so a MISSING one means the read was cut
 *    short (dead master, killed mid-stream) rather than "the host had nothing".
 *  - The headers are QUOTED. `echo ##MEM` prints an EMPTY LINE: an unquoted `#` at the start of a
 *    word begins a comment in POSIX sh, so the marker is eaten by the shell and every report comes
 *    back `ok:false`. Measured under dash. Do not drop the quotes.
 *  - `tmux ... || true` — a host with no tmux server must exit 0. "No sessions" is an answer.
 *  - The socket names and the `-F` format come from the shared constants, so the remote sweep can
 *    never look at a different socket, or ask for different fields, than the local one.
 *  - `ps -eo pid,ppid,rss` is used even on Linux hosts: it is one process instead of thousands of
 *    /proc reads over a link we do not control, and its output is what we already parse.
 */
export function remoteSessionMemoryCommand(): string {
  const listPanes = (socket: string): string =>
    `tmux -L ${socket} list-panes -a -F '${PANE_FMT}' 2>/dev/null`
  return [
    `echo '${MEM}'`,
    `cat /proc/meminfo 2>/dev/null | grep -E '^(MemAvailable|MemTotal):' || true`,
    `echo '${PANES}'`,
    `{ ${listPanes(TMUX_SOCKET)}; ${listPanes(RMT_TMUX_SOCKET)}; } || true`,
    `echo '${PROCS}'`,
    `ps -eo pid,ppid,rss 2>/dev/null || true`
  ].join('\n')
}

function parseMem(lines: string[]): MemInfo | null {
  let availableMb: number | null = null
  let totalMb: number | null = null
  for (const l of lines) {
    const a = /MemAvailable:\s+(\d+)\s*kB/.exec(l)
    if (a) availableMb = Math.round(Number(a[1]) / 1024)
    const t = /MemTotal:\s+(\d+)\s*kB/.exec(l)
    if (t) totalMb = Math.round(Number(t[1]) / 1024)
  }
  return availableMb !== null && totalMb !== null ? { availableMb, totalMb } : null
}

/** Split the fenced sections and reuse the LOCAL assembly, so both legs cannot drift. */
export function parseRemoteSessionMemory(stdout: string): SessionMemoryReport {
  // Tolerant of a CR-terminated stream (an ssh channel that ended up on a pty): the section
  // markers are matched whole-line, so a stray \r would hide every one of them.
  const lines = stdout.split('\n').map((l) => l.replace(/\r$/, ''))
  const iMem = lines.indexOf(MEM)
  const iPanes = lines.indexOf(PANES)
  const iProcs = lines.indexOf(PROCS)
  // A missing header means the stream was cut short — not evidence that the host has nothing.
  if (iMem < 0 || iPanes < 0 || iProcs < 0) return { ok: false, rows: [], mem: null }

  const mem = parseMem(lines.slice(iMem + 1, iPanes))
  const panes = parsePaneList(lines.slice(iPanes + 1, iProcs).join('\n'))
  const table = parseProcessTable(lines.slice(iProcs + 1).join('\n'))
  // A host always has processes, so an empty table means `ps` never ran (or its output was lost).
  if (table.length === 0) return { ok: false, rows: [], mem }

  // Both sockets print into ONE section and `list-panes -a` emits a line per PANE, so a session
  // can appear several times. First pane of a session wins — one session is one row, exactly as
  // the local leg's `bySession` map guarantees.
  const bySession = new Map<string, PaneRef>()
  for (const p of panes) if (!bySession.has(p.session)) bySession.set(p.session, p)
  return buildReport([...bySession.values()], table, mem)
}

/** Runs a POSIX sh command on the project's host; resolves stdout, or null if it could not run. */
export type RemoteSessionMemoryRunner = (
  projectId: string,
  command: string
) => Promise<string | null>

export async function fetchRemoteSessionMemory(
  projectId: string,
  run: RemoteSessionMemoryRunner
): Promise<SessionMemoryReport> {
  let stdout: string | null = null
  try {
    stdout = await run(projectId, remoteSessionMemoryCommand())
  } catch {
    return { ok: false, rows: [], mem: null }
  }
  // A dead master says nothing about what the host is running.
  if (stdout === null) return { ok: false, rows: [], mem: null }
  return parseRemoteSessionMemory(stdout)
}
