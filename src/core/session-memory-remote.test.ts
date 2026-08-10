import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  remoteSessionMemoryCommand,
  parseRemoteSessionMemory,
  fetchRemoteSessionMemory
} from './session-memory-remote'

const run = promisify(execFile)

describe('parseRemoteSessionMemory', () => {
  it('parses all three sections into a report', () => {
    const r = parseRemoteSessionMemory(
      '##MEM\nMemAvailable: 13500000 kB\nMemTotal: 65700000 kB\n' +
        '##PANES\nnt-term-a|100|claude\n' +
        '##PROCS\n100 1 1024\n200 100 358400\n'
    )
    expect(r.ok).toBe(true)
    expect(r.mem).toEqual({ availableMb: 13184, totalMb: 64160 })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ nodeId: 'term-a', selfMb: 1, childrenMb: 350 })
  })

  it('reports ok:false when the PROCS section is missing (the read was cut short)', () => {
    const r = parseRemoteSessionMemory('##MEM\n##PANES\nnt-term-a|100|claude\n')
    expect(r.ok).toBe(false)
    expect(r.rows).toEqual([])
  })

  it('reports ok:true with no rows when the host has no nt- sessions', () => {
    const r = parseRemoteSessionMemory('##MEM\n##PANES\n##PROCS\n100 1 1024\n')
    expect(r.ok).toBe(true)
    expect(r.rows).toEqual([])
  })

  // An ssh exec channel is not a clean pipe — a login shell's rc file can write to stdout ahead of
  // our first marker. Out-of-order markers must fail closed, not produce a confident empty report.
  // The stream below is a COMPLETE, healthy sweep with one stray `##PROCS` echoed ahead of it by a
  // login shell's rc file. Every part must stay realistic: the real PROCS tail still parses, so the
  // empty-table check does NOT catch this, and without the ordering guard the panes slice comes out
  // empty and the report is a confident `{ok:true, rows:[]}` over a host with live sessions.
  it('reports ok:false when the markers arrive out of order', () => {
    const r = parseRemoteSessionMemory(
      '##PROCS\n' +
        '##MEM\nMemAvailable: 1024 kB\nMemTotal: 2048 kB\n' +
        '##PANES\nnt-term-a|100|claude\n' +
        '##PROCS\n100 1 1024\n200 100 358400\n'
    )
    expect(r.ok).toBe(false)
    expect(r.rows).toEqual([])
  })

  // A marker string inside DATA is not a marker: only a whole line counts, and only the first one.
  it('is not confused by a marker appearing inside pane or process data', () => {
    const r = parseRemoteSessionMemory(
      '##MEM\nMemAvailable: 1024 kB\nMemTotal: 2048 kB\n' +
        '##PANES\nnt-term-b|300|##PROCS\n' +
        '##PROCS\n300 1 1024\n##PANES\n400 1 2048\n'
    )
    expect(r.ok).toBe(true)
    expect(r.mem).toEqual({ availableMb: 1, totalMb: 2 })
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ nodeId: 'term-b', command: '##PROCS', selfMb: 1, totalMb: 1 })
  })

  // Both sockets are swept in ONE stream, and `list-panes -a` prints a line per PANE, so the same
  // session can appear several times. It is still one session, hence one row (the local leg's
  // `bySession` map makes the same promise).
  it('collapses a session reported by several panes into one row', () => {
    const r = parseRemoteSessionMemory(
      '##MEM\n##PANES\nnt-term-a|100|claude\nnt-term-a|300|bash\n##PROCS\n100 1 1024\n300 1 2048\n'
    )
    expect(r.ok).toBe(true)
    expect(r.rows.map((x) => x.panePid)).toEqual([100])
  })
})

describe('fetchRemoteSessionMemory', () => {
  it('reports ok:false when the command could not run (a dead master says nothing)', async () => {
    const r = await fetchRemoteSessionMemory('p1', async () => null)
    expect(r.ok).toBe(false)
  })

  it('reports ok:false when the runner throws', async () => {
    const r = await fetchRemoteSessionMemory('p1', async () => {
      throw new Error('master down')
    })
    expect(r.ok).toBe(false)
  })
})

// The command is generated shell that no compiler checks. Run it for real.
describe('remoteSessionMemoryCommand under /bin/sh', () => {
  let dir: string

  // A fake tmux that answers list-panes and nothing else. It reports `$PPID` — the sh running our
  // generated command — NOT its own `$$`: the fake exits immediately, so a `$$` pid is already dead
  // by the time `ps` runs and every row would roll up to 0, making a size assertion vacuous.
  // `$PPID` is alive for the whole sweep, so the row proves the rollup really joined the pane pid
  // to the host's process table.
  const FAKE_TMUX =
    '#!/bin/sh\nfor a in "$@"; do [ "$a" = "list-panes" ] && { echo "nt-term-a|$PPID|claude"; exit 0; }; done\nexit 1\n'

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessmem-'))
    fs.writeFileSync(path.join(dir, 'tmux'), FAKE_TMUX)
    fs.chmodSync(path.join(dir, 'tmux'), 0o755)
  })

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('produces a parseable report on a host with a tmux server', async () => {
    const { stdout } = await run('/bin/sh', ['-c', remoteSessionMemoryCommand()], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` }
    })
    const r = parseRemoteSessionMemory(stdout)
    expect(r.ok).toBe(true)
    expect(r.rows.map((x) => x.nodeId)).toEqual(['term-a'])
    // The pane pid was resolved against the REAL process table: a live shell plus its children.
    // A 0 here would mean the rollup never found the pid, which is the failure worth catching.
    expect(r.rows[0].totalMb).toBeGreaterThan(0)
    expect(r.mem).not.toBeNull()
  })

  // A host with no /proc/meminfo (the macOS/BSD shape). Deliberately NO free/vm_stat/sysctl
  // fallback: the sweep still answers with rows, and `mem` is null = "no signal", never a zero.
  it('still reports rows with mem:null when /proc/meminfo is unreadable', async () => {
    const noproc = fs.mkdtempSync(path.join(os.tmpdir(), 'sessmem-nomem-'))
    fs.writeFileSync(path.join(noproc, 'tmux'), FAKE_TMUX)
    fs.chmodSync(path.join(noproc, 'tmux'), 0o755)
    // Stub `cat` so reading /proc/meminfo fails the way it does off Linux.
    fs.writeFileSync(path.join(noproc, 'cat'), '#!/bin/sh\nexit 1\n')
    fs.chmodSync(path.join(noproc, 'cat'), 0o755)
    const { stdout } = await run('/bin/sh', ['-c', remoteSessionMemoryCommand()], {
      env: { ...process.env, PATH: `${noproc}:${process.env.PATH ?? ''}` }
    })
    const r = parseRemoteSessionMemory(stdout)
    expect(r.ok).toBe(true)
    expect(r.mem).toBeNull()
    expect(r.rows.map((x) => x.nodeId)).toEqual(['term-a'])
    fs.rmSync(noproc, { recursive: true, force: true })
  })

  it('exits 0 and reports no rows when no tmux server is running', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sessmem-notmux-'))
    fs.writeFileSync(path.join(empty, 'tmux'), '#!/bin/sh\nexit 1\n')
    fs.chmodSync(path.join(empty, 'tmux'), 0o755)
    const { stdout } = await run('/bin/sh', ['-c', remoteSessionMemoryCommand()], {
      env: { ...process.env, PATH: `${empty}:${process.env.PATH ?? ''}` }
    })
    const r = parseRemoteSessionMemory(stdout)
    // A clean miss is an ANSWER: the sweep ran, the host simply has nothing.
    expect(r.ok).toBe(true)
    expect(r.rows).toEqual([])
    fs.rmSync(empty, { recursive: true, force: true })
  })
})
