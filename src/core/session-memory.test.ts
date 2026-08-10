import { describe, it, expect } from 'vitest'
import {
  indexProcesses,
  rollupTree,
  parseProcessTable,
  parsePaneList,
  buildReport,
  collectSessionMemory,
  type ProcEntry
} from './session-memory'

const P = (pid: number, ppid: number, rssKb: number): ProcEntry => ({ pid, ppid, rssKb })

describe('indexProcesses + rollupTree', () => {
  it('sums a pane pid and every descendant, splitting self from children', () => {
    // pane(100) -> claude(200) -> mcp(300), and claude also has mcp2(301)
    const { table, kids } = indexProcesses([
      P(100, 1, 1024),
      P(200, 100, 350 * 1024),
      P(300, 200, 30 * 1024),
      P(301, 200, 20 * 1024)
    ])
    const r = rollupTree(table, kids, 100)
    expect(r.selfMb).toBe(1)
    expect(r.childrenMb).toBe(400)
    expect(r.childCount).toBe(3)
    expect(r.totalMb).toBe(401)
  })

  it('returns zeros for a pid that is not in the table', () => {
    const { table, kids } = indexProcesses([P(100, 1, 1024)])
    expect(rollupTree(table, kids, 999)).toEqual({
      selfMb: 0,
      childrenMb: 0,
      childCount: 0,
      totalMb: 0
    })
  })

  it('does not loop forever on a cyclic ppid chain', () => {
    // A pid whose parent chain points back at it must not hang the sweep.
    const { table, kids } = indexProcesses([P(100, 200, 1024), P(200, 100, 1024)])
    const r = rollupTree(table, kids, 100)
    expect(r.totalMb).toBe(2)
    expect(r.childCount).toBe(1)
  })
})

describe('parseProcessTable', () => {
  it('parses ps output and skips the header and malformed lines', () => {
    const out = parseProcessTable(
      '  PID  PPID    RSS COMMAND\n' +
        '  100     1   1024 tmux\n' +
        'garbage line\n' +
        '  200   100 358400 claude\n'
    )
    expect(out).toEqual([
      { pid: 100, ppid: 1, rssKb: 1024 },
      { pid: 200, ppid: 100, rssKb: 358400 }
    ])
  })

  it('returns an empty array for empty input rather than throwing', () => {
    expect(parseProcessTable('')).toEqual([])
  })
})

describe('parsePaneList', () => {
  it('parses the pipe-delimited pane list and skips malformed lines', () => {
    expect(
      parsePaneList('nt-term-a|100|claude\nbroken\nnt-term-b|200|zsh\n|300|x\n')
    ).toEqual([
      { session: 'nt-term-a', panePid: 100, command: 'claude' },
      { session: 'nt-term-b', panePid: 200, command: 'zsh' }
    ])
  })
})

describe('buildReport', () => {
  it('rolls up each nt- session and sorts by total descending', () => {
    const r = buildReport(
      [
        { session: 'nt-small', panePid: 100, command: 'zsh' },
        { session: 'nt-big', panePid: 200, command: 'claude' }
      ],
      [
        P(100, 1, 40 * 1024),
        P(200, 1, 350 * 1024),
        P(201, 200, 50 * 1024)
      ],
      { availableMb: 1000, totalMb: 64000 }
    )
    expect(r.ok).toBe(true)
    expect(r.rows.map((x) => x.session)).toEqual(['nt-big', 'nt-small'])
    expect(r.rows[0]).toMatchObject({
      nodeId: 'big',
      totalMb: 400,
      selfMb: 350,
      childrenMb: 50,
      childCount: 1,
      command: 'claude'
    })
  })

  it('ignores sessions that are not nt- prefixed', () => {
    const r = buildReport(
      [{ session: 'my-own-tmux', panePid: 100, command: 'zsh' }],
      [P(100, 1, 40 * 1024)],
      null
    )
    expect(r.rows).toEqual([])
  })
})

describe('collectSessionMemory', () => {
  const table = [P(100, 1, 40 * 1024), P(200, 1, 350 * 1024)]

  it('reports ok:false with no rows when the process table cannot be read', async () => {
    const r = await collectSessionMemory({
      tmuxBin: () => '/usr/bin/tmux',
      sockets: ['s1'],
      exec: async () => 'nt-a|100|claude\n',
      readTable: () => null,
      readMem: () => ({ availableMb: 1, totalMb: 2 })
    })
    // "could not look" must never render as "uses nothing".
    expect(r.ok).toBe(false)
    expect(r.rows).toEqual([])
  })

  it('reports ok:true with no rows when tmux has no server (a real answer)', async () => {
    const r = await collectSessionMemory({
      tmuxBin: () => '/usr/bin/tmux',
      sockets: ['s1'],
      exec: async () => {
        throw new Error('no server running')
      },
      readTable: () => table,
      readMem: () => null
    })
    expect(r.ok).toBe(true)
    expect(r.rows).toEqual([])
  })

  it('reports ok:false when tmux is unavailable entirely', async () => {
    const r = await collectSessionMemory({ tmuxBin: () => null, readTable: () => table })
    expect(r.ok).toBe(false)
  })

  it('merges panes from every socket and dedupes by session name', async () => {
    const r = await collectSessionMemory({
      tmuxBin: () => '/usr/bin/tmux',
      sockets: ['s1', 's2'],
      exec: async (_bin, args) =>
        args[1] === 's1' ? 'nt-a|100|zsh\n' : 'nt-b|200|claude\nnt-a|100|zsh\n',
      readTable: () => table,
      readMem: () => null
    })
    expect(r.rows.map((x) => x.session).sort()).toEqual(['nt-a', 'nt-b'])
  })
})
