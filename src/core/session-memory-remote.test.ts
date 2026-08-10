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

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessmem-'))
    // A fake tmux on PATH that answers list-panes and nothing else.
    fs.writeFileSync(
      path.join(dir, 'tmux'),
      '#!/bin/sh\nfor a in "$@"; do [ "$a" = "list-panes" ] && { echo "nt-term-a|$$|claude"; exit 0; }; done\nexit 1\n'
    )
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
    // The row resolved against the REAL process table, so it has a real size.
    expect(r.rows[0].totalMb).toBeGreaterThanOrEqual(0)
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
