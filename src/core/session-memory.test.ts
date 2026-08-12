import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import {
  indexProcesses,
  rollupTree,
  parseProcessTable,
  parsePaneList,
  buildReport,
  collectSessionMemory,
  isNoServerError,
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
    // `nt-zero||sh` is the phantom case: an empty pid field parses as 0, which IS finite, so a
    // finite-only guard would emit a 0 MB row for a pid that cannot exist.
    expect(
      parsePaneList('nt-term-a|100|claude\nbroken\nnt-term-b|200|zsh\n|300|x\nnt-zero||sh\n')
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
    // The host total is still a real reading — the failure path must not throw it away.
    expect(r.mem).toEqual({ availableMb: 1, totalMb: 2 })
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
    expect(r.rows).toEqual([])
  })

  it('counts "no server" as an answer but a permission failure as a failure', () => {
    expect(isNoServerError('no server running on /tmp/tmux-0/node-terminal')).toBe(true)
    expect(isNoServerError('error connecting to /tmp/x (No such file or directory)')).toBe(true)
    // A socket dir we may not read says nothing about whether sessions exist there.
    expect(isNoServerError('error connecting to /tmp/x (Permission denied)')).toBe(false)
    expect(isNoServerError('killed: timeout')).toBe(false)
    // The regression the anchor exists for: stderr that merely CONTAINS the errno phrase. A tmux
    // client that cannot load a library fails this way on EVERY socket — same binary — so counting
    // it as an answer would print "no sessions" while the already-running server holds live ones.
    expect(
      isNoServerError(
        'Command failed: tmux -L node-terminal list-panes\ntmux: error while loading shared ' +
          'libraries: libtinfo.so.6: cannot open shared object file: No such file or directory'
      )
    ).toBe(false)
    // Same shape one layer out: a dead ssh ControlMaster, which this sweep may later run over.
    expect(isNoServerError('Control socket connect(/tmp/cm.sock): No such file or directory')).toBe(
      false
    )
  })

  it('reports ok:false when NO socket answered', async () => {
    // One socket erroring is normal (nobody used it). Every socket erroring means we never looked,
    // and "we never looked" must not render as "there are no sessions".
    const r = await collectSessionMemory({
      tmuxBin: () => '/usr/bin/tmux',
      sockets: ['s1', 's2'],
      exec: async () => {
        throw new Error('connect failed')
      },
      readTable: () => table,
      readMem: () => null
    })
    expect(r.ok).toBe(false)
    expect(r.rows).toEqual([])
  })

  it('merges panes from every socket and the first socket wins a duplicate session', async () => {
    const r = await collectSessionMemory({
      tmuxBin: () => '/usr/bin/tmux',
      sockets: ['s1', 's2'],
      exec: async (_bin, args) =>
        args[1] === 's1' ? 'nt-a|100|zsh\n' : 'nt-b|200|claude\nnt-a|999|claude\n',
      readTable: () => table,
      readMem: () => null
    })
    expect(r.rows.map((x) => x.session).sort()).toEqual(['nt-a', 'nt-b'])
    // s2 also reported nt-a, with a different pid and command: s1's entry must be the one kept.
    expect(r.rows.find((x) => x.session === 'nt-a')).toMatchObject({
      panePid: 100,
      command: 'zsh'
    })
  })

  it('routes the ps fallback through the injected exec seam', async () => {
    // With no readTable injected the default /proc reader runs first; make it fail so the `ps`
    // fallback is reached on every platform, including the Linux box this suite runs on.
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw new Error('/proc unreadable')
    })
    try {
      const calls: string[] = []
      const r = await collectSessionMemory({
        tmuxBin: () => '/usr/bin/tmux',
        sockets: ['s1'],
        exec: async (bin) => {
          calls.push(bin)
          if (bin === 'ps') return '  PID  PPID    RSS\n  100     1   1024\n'
          return 'nt-a|100|zsh\n'
        },
        readMem: () => null
      })
      // The `ps` call must come THROUGH the seam, not around it — otherwise this path can never
      // be driven by a test and the file's "every exec is injectable" promise is false.
      expect(calls).toContain('ps')
      expect(r.ok).toBe(true)
      expect(r.rows[0]).toMatchObject({ session: 'nt-a', selfMb: 1 })
    } finally {
      spy.mockRestore()
    }
  })
})

import { parseVmStat, darwinMemInfo } from './session-memory'

/** Shaped from Apple's documented `vm_stat` format, at a 16 KiB page (Apple Silicon). COMPOSED, not
 *  captured — nobody in this loop has a Mac. Numbers chosen so the arithmetic is checkable by hand:
 *  anonymous 800k - purgeable 50k + wired 150k + compressor 100k = 1,000,000 pages.
 *  1,000,000 x 16384 B = 15625 MiB used of a 24576 MiB machine, i.e. 8951 MiB available. */
const VM_STAT = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                                50000.',
  'Pages active:                             600000.',
  'Pages inactive:                           400000.',
  'Pages speculative:                         30000.',
  'Pages throttled:                               0.',
  'Pages wired down:                         150000.',
  'Pages purgeable:                           50000.',
  '"Translation faults":                  987654321.',
  'Pages occupied by compressor:             100000.',
  'File-backed pages:                        700000.',
  'Anonymous pages:                          800000.'
].join('\n')

const TOTAL_BYTES = 24576 * 1048576

describe('parseVmStat', () => {
  it('reports app+wired+compressed as used, not the near-zero free page count', () => {
    // The bug this exists for: `Pages free` is 50000 (≈781 MiB) on a machine with 8.4 GiB genuinely
    // available, because macOS holds the rest as reclaimable cache.
    expect(parseVmStat(VM_STAT, TOTAL_BYTES)).toEqual({ availableMb: 8951, totalMb: 24576 })
  })

  it('reads the page size from the header rather than assuming 4096', () => {
    // Same class as the Linux statm bug: a hard-coded 4096 would report a QUARTER of the real usage
    // on Apple Silicon, i.e. an alarmingly empty machine.
    const fourK = parseVmStat(VM_STAT.replace('16384 bytes', '4096 bytes'), TOTAL_BYTES)
    // 1,000,000 x 4096 B = 3906 MiB, so the machine would read 5044 MiB emptier than it is.
    expect(fourK).toEqual({ availableMb: 20670, totalMb: 24576 })
  })

  it('subtracts purgeable pages from anonymous — they are droppable cache, not app memory', () => {
    const noPurge = parseVmStat(VM_STAT.replace(/Pages purgeable:.*\n/, ''), TOTAL_BYTES)
    // Without the subtraction the machine reads 50000 pages (781 MiB) fuller than it is.
    expect(noPurge?.availableMb).toBe(8951 - 781)
  })

  it('returns null when a field it needs is missing, rather than a partial number', () => {
    expect(parseVmStat(VM_STAT.replace(/Pages wired down:.*\n/, ''), TOTAL_BYTES)).toBeNull()
    expect(parseVmStat('not vm_stat output', TOTAL_BYTES)).toBeNull()
    expect(parseVmStat(VM_STAT, 0)).toBeNull()
  })

  it('never reports negative availability on a heavily compressed machine', () => {
    const tiny = parseVmStat(VM_STAT, 1024 * 1048576)
    expect(tiny?.availableMb).toBe(0)
  })
})

describe('darwinMemInfo', () => {
  it('reports null when vm_stat cannot run — never the os.freemem() value', () => {
    // The whole point. Falling back to os.freemem() here would restore the bug: on macOS it reads
    // near zero, the reaper's 10%-of-RAM watermark reads as permanent pressure, and idle detached
    // sessions get reaped every sweep. A confirmed field symptom ("my sessions keep disappearing").
    // planReap treats null as NO pressure, so no signal is the safe answer.
    expect(
      darwinMemInfo(() => {
        throw new Error('spawn vm_stat ENOENT')
      }, TOTAL_BYTES)
    ).toBeNull()
  })

  it('reports null on output it cannot parse', () => {
    expect(darwinMemInfo(() => 'garbage', TOTAL_BYTES)).toBeNull()
  })

  it('passes a good reading through', () => {
    expect(darwinMemInfo(() => VM_STAT, TOTAL_BYTES)).toEqual({ availableMb: 8951, totalMb: 24576 })
  })
})
