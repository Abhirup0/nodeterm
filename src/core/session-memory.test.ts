import { describe, it, expect } from 'vitest'
import { indexProcesses, rollupTree, parseProcessTable, type ProcEntry } from './session-memory'

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
