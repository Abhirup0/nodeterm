import { describe, expect, it } from 'vitest'
import {
  planReap,
  parseSessionList,
  sessionBudgetConfig,
  createSessionReaper,
  type SessionInfo,
  type SessionBudgetConfig
} from './session-budget'

const NOW = 1_753_000_000 // fixed epoch seconds for every test

const cfg = (over: Partial<SessionBudgetConfig> = {}): SessionBudgetConfig => ({
  disabled: false,
  minAvailableMb: 2048,
  maxDetached: 48,
  graceSec: 6 * 3600,
  batchMax: 8,
  ...over
})

/** A detached nt- session idle for `idleH` hours. */
const idle = (name: string, idleH: number, attached = false): SessionInfo => ({
  name,
  attached,
  activitySec: NOW - idleH * 3600
})

const lowMem = { availableMb: 500, totalMb: 64_000 }
const okMem = { availableMb: 30_000, totalMb: 64_000 }

describe('planReap (pure policy)', () => {
  it('under memory pressure, reaps the least-recently-active detached sessions first', () => {
    const plan = planReap([idle('nt-old', 240), idle('nt-mid', 48), idle('nt-new', 7)], lowMem, NOW, cfg({ batchMax: 2 }))
    expect(plan).toEqual(['nt-old', 'nt-mid'])
  })

  it('never reaps an attached session, no matter how idle', () => {
    const plan = planReap([idle('nt-watched', 500, true), idle('nt-idle', 500)], lowMem, NOW, cfg())
    expect(plan).toEqual(['nt-idle'])
  })

  it('never reaps within the grace window, even under pressure', () => {
    const plan = planReap([idle('nt-recent', 1), idle('nt-old', 100)], lowMem, NOW, cfg())
    expect(plan).toEqual(['nt-old'])
  })

  it('ignores sessions not named nt-* (a user session on the same socket is untouchable)', () => {
    const plan = planReap([idle('main', 500), idle('nt-x', 500)], lowMem, NOW, cfg())
    expect(plan).toEqual(['nt-x'])
  })

  it('healthy memory + under cap → reaps nothing', () => {
    const plan = planReap([idle('nt-a', 500), idle('nt-b', 500)], okMem, NOW, cfg())
    expect(plan).toEqual([])
  })

  it('a FAILED memory read is not pressure (mem=null never triggers the watermark)', () => {
    const plan = planReap([idle('nt-a', 500)], null, NOW, cfg())
    expect(plan).toEqual([])
  })

  it('count cap is a backstop: excess detached sessions are reaped even with healthy memory', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => idle(`nt-s${i}`, 100 + i))
    const plan = planReap(sessions, okMem, NOW, cfg({ maxDetached: 7 }))
    // 10 detached, cap 7 → 3 oldest go (highest idle hours = oldest activity)
    expect(plan).toEqual(['nt-s9', 'nt-s8', 'nt-s7'])
  })

  it('attached sessions do not count toward freeing the cap, but are never the ones killed', () => {
    const sessions = [idle('nt-live', 500, true), ...Array.from({ length: 5 }, (_, i) => idle(`nt-d${i}`, 100 + i))]
    const plan = planReap(sessions, okMem, NOW, cfg({ maxDetached: 4 }))
    expect(plan).toEqual(['nt-d4'])
  })

  it('combined triggers stay bounded by batchMax per sweep (gradual convergence)', () => {
    const sessions = Array.from({ length: 30 }, (_, i) => idle(`nt-s${i}`, 100 + i))
    const plan = planReap(sessions, lowMem, NOW, cfg({ maxDetached: 5, batchMax: 4 }))
    expect(plan).toHaveLength(4)
  })

  it('disabled kill switch plans nothing', () => {
    const plan = planReap([idle('nt-a', 500)], lowMem, NOW, cfg({ disabled: true }))
    expect(plan).toEqual([])
  })

  it('pressure alone reaps at most batchMax even with many eligible', () => {
    const sessions = Array.from({ length: 20 }, (_, i) => idle(`nt-s${i}`, 100 + i))
    const plan = planReap(sessions, lowMem, NOW, cfg({ batchMax: 3 }))
    expect(plan).toHaveLength(3)
  })
})

describe('parseSessionList', () => {
  it('parses names, attached counts and activity, skipping malformed lines', () => {
    const out = parseSessionList('nt-a|0|1753000000\nnt-b|2|1753000100\n\njunk\nx|y|z\n')
    expect(out).toEqual([
      { name: 'nt-a', attached: false, activitySec: 1_753_000_000 },
      { name: 'nt-b', attached: true, activitySec: 1_753_000_100 }
    ])
  })
})

describe('sessionBudgetConfig', () => {
  it('defaults: 10% of RAM watermark (floor 1GB), cap 48, grace 6h, batch 8', () => {
    const c = sessionBudgetConfig({}, 64_000)
    expect(c).toEqual({ disabled: false, minAvailableMb: 6400, maxDetached: 48, graceSec: 21_600, batchMax: 8 })
    expect(sessionBudgetConfig({}, 4000).minAvailableMb).toBe(1024)
  })

  it('env overrides win; junk values fall back', () => {
    const c = sessionBudgetConfig(
      {
        NODETERM_SESSION_MIN_AVAILABLE_MB: '3000',
        NODETERM_SESSION_MAX_DETACHED: 'garbage',
        NODETERM_SESSION_GRACE_HOURS: '12',
        NODETERM_SESSION_REAP_DISABLED: '1'
      },
      64_000
    )
    expect(c.minAvailableMb).toBe(3000)
    expect(c.maxDetached).toBe(48)
    expect(c.graceSec).toBe(43_200)
    expect(c.disabled).toBe(true)
  })
})

// ---- service over fake exec ------------------------------------------------------------------

type Call = { args: string[] }

function fakeWorld(listings: Record<string, string[]>): {
  calls: Call[]
  exec: (bin: string, args: string[]) => Promise<string>
} {
  const calls: Call[] = []
  return {
    calls,
    exec: async (_bin, args) => {
      calls.push({ args })
      const socket = args[1]
      if (args[2] === 'list-sessions') {
        const lines = listings[socket]
        if (!lines) throw new Error('no server running')
        return lines.join('\n')
      }
      return '' // kill-session
    }
  }
}

const OLD = String(NOW - 100 * 3600)

describe('createSessionReaper (service)', () => {
  const base = {
    readMem: () => ({ availableMb: 100, totalMb: 64_000 }),
    env: {} as NodeJS.ProcessEnv,
    nowSec: () => NOW,
    log: () => {}
  }

  it('sweeps every socket, kills planned sessions on the right socket with exact-match targets', async () => {
    const w = fakeWorld({
      'node-terminal': [`nt-local|0|${OLD}`],
      'nodeterm-rmt': [`nt-remote|0|${OLD}`]
    })
    const reaper = createSessionReaper({ ...base, tmuxBin: () => 'tmux', exec: w.exec })
    expect(await reaper.sweep()).toBe(2)
    const kills = w.calls.filter((c) => c.args[2] === 'kill-session')
    expect(kills).toEqual([
      { args: ['-L', 'node-terminal', 'kill-session', '-t', '=nt-local'] },
      { args: ['-L', 'nodeterm-rmt', 'kill-session', '-t', '=nt-remote'] }
    ])
  })

  it('re-verifies at kill time: a session attached between plan and kill is spared', async () => {
    let first = true
    const w = fakeWorld({})
    const exec = async (bin: string, args: string[]): Promise<string> => {
      if (args[2] === 'list-sessions' && args[1] === 'node-terminal') {
        if (first) {
          first = false
          return `nt-x|0|${OLD}`
        }
        return `nt-x|1|${OLD}` // now attached
      }
      return w.exec(bin, args)
    }
    const reaper = createSessionReaper({ ...base, tmuxBin: () => 'tmux', sockets: ['node-terminal'], exec })
    expect(await reaper.sweep()).toBe(0)
    expect(w.calls.filter((c) => c.args[2] === 'kill-session')).toHaveLength(0)
  })

  it('a socket whose listing fails contributes no candidates; the other socket still sweeps', async () => {
    const w = fakeWorld({ 'nodeterm-rmt': [`nt-r|0|${OLD}`] }) // node-terminal listing throws
    const reaper = createSessionReaper({ ...base, tmuxBin: () => 'tmux', exec: w.exec })
    expect(await reaper.sweep()).toBe(1)
    const kills = w.calls.filter((c) => c.args[2] === 'kill-session')
    expect(kills).toEqual([{ args: ['-L', 'nodeterm-rmt', 'kill-session', '-t', '=nt-r'] }])
  })

  it('kill switch: disabled env runs no tmux commands at all', async () => {
    const w = fakeWorld({ 'node-terminal': [`nt-x|0|${OLD}`] })
    const reaper = createSessionReaper({
      ...base,
      env: { NODETERM_SESSION_REAP_DISABLED: '1' },
      tmuxBin: () => 'tmux',
      exec: w.exec
    })
    expect(await reaper.sweep()).toBe(0)
    expect(w.calls).toHaveLength(0)
  })

  it('tmux unavailable (bin=null) → quiet no-op', async () => {
    const w = fakeWorld({ 'node-terminal': [`nt-x|0|${OLD}`] })
    const reaper = createSessionReaper({ ...base, tmuxBin: () => null, exec: w.exec })
    expect(await reaper.sweep()).toBe(0)
    expect(w.calls).toHaveLength(0)
  })

  it('a failing kill is tolerated and does not abort the rest of the batch', async () => {
    const w = fakeWorld({ 'node-terminal': [`nt-a|0|${OLD}`, `nt-b|0|${String(NOW - 99 * 3600)}`] })
    const exec = async (bin: string, args: string[]): Promise<string> => {
      if (args[2] === 'kill-session' && args[4] === '=nt-a') throw new Error('gone already')
      return w.exec(bin, args)
    }
    const reaper = createSessionReaper({ ...base, tmuxBin: () => 'tmux', sockets: ['node-terminal'], exec })
    expect(await reaper.sweep()).toBe(1) // nt-b still dies
  })

  it('healthy memory + under cap → lists but never kills', async () => {
    const w = fakeWorld({ 'node-terminal': [`nt-x|0|${OLD}`] })
    const reaper = createSessionReaper({
      ...base,
      readMem: () => ({ availableMb: 30_000, totalMb: 64_000 }),
      tmuxBin: () => 'tmux',
      exec: w.exec
    })
    expect(await reaper.sweep()).toBe(0)
    expect(w.calls.filter((c) => c.args[2] === 'kill-session')).toHaveLength(0)
  })
})
