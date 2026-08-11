import { describe, it, expect } from 'vitest'
import { planHibernation, HIBERNATE_BATCH_MAX } from './hibernation-policy'

const base = (id: string, over: object = {}) => ({
  id,
  agentId: 'claude',
  state: 'done',
  sessionId: 's-' + id,
  wired: true,
  offscreen: true,
  hibernated: false,
  recurring: false,
  liveSubagents: false,
  lastEventAt: 0,
  ...over
})
const cfg = { enabled: true, idleMinutes: 30 }
const NOW = 100 * 60_000

describe('planHibernation', () => {
  it('takes only done, offscreen, wired, long-idle nodes; oldest first; max 2', () => {
    const out = planHibernation(
      [
        base('a', { lastEventAt: 10 * 60_000 }),
        base('b', { lastEventAt: 5 * 60_000 }),
        base('c', { lastEventAt: 1 * 60_000 }),
        base('d', { state: 'working' }),
        base('e', { offscreen: false }),
        base('f', { lastEventAt: undefined }),
        base('g', { hibernated: true }),
        base('h', { wired: false }),
        base('i', { state: 'waiting' }),
        base('j', { recurring: true }),
        base('k', { liveSubagents: true })
      ],
      NOW,
      cfg
    )
    expect(out).toEqual(['c', 'b'])
    expect(HIBERNATE_BATCH_MAX).toBe(2)
  })

  it('never hibernates a recurring (loop/cron/schedule) node, however idle', () => {
    expect(planHibernation([base('a', { recurring: true, lastEventAt: 0 })], NOW, cfg)).toEqual([])
  })

  it('never hibernates a node with a live subagent, however idle', () => {
    expect(planHibernation([base('a', { liveSubagents: true, lastEventAt: 0 })], NOW, cfg)).toEqual(
      []
    )
  })

  it('never hibernates a waiting node — the question would be swallowed', () => {
    expect(planHibernation([base('a', { state: 'waiting' })], NOW, cfg)).toEqual([])
    expect(planHibernation([base('a', { state: 'blocked' })], NOW, cfg)).toEqual([])
    expect(planHibernation([base('a', { state: undefined })], NOW, cfg)).toEqual([])
  })

  it('never hibernates a node with no lastEventAt — unknown idle is not idle', () => {
    expect(planHibernation([base('a', { lastEventAt: undefined })], NOW, cfg)).toEqual([])
  })

  it('disabled → empty', () => {
    expect(planHibernation([base('a')], NOW, { ...cfg, enabled: false })).toEqual([])
  })

  it('idle window respected', () => {
    expect(planHibernation([base('a', { lastEventAt: NOW - 29 * 60_000 })], NOW, cfg)).toEqual([])
    // Exactly at the window is eligible (>=, not >).
    expect(planHibernation([base('a', { lastEventAt: NOW - 30 * 60_000 })], NOW, cfg)).toEqual(['a'])
  })

  it('refuses a non-positive / unreadable idle window — settings.json is hand-editable', () => {
    // settings.json is hand-edited and merged without clamping, so any of these can reach here.
    // Each must read as "off": a 0 or negative window makes EVERY done+offscreen node eligible on
    // the first sweep — Eco would exit live CLIs the instant a turn ends.
    for (const idleMinutes of [0, -1, -30, NaN, null as unknown as number, undefined as unknown as number]) {
      expect(planHibernation([base('a')], NOW, { ...cfg, idleMinutes }), String(idleMinutes)).toEqual([])
    }
    // …but a small positive window is honored, not floored away.
    expect(planHibernation([base('a', { lastEventAt: NOW - 60_000 })], NOW, { ...cfg, idleMinutes: 1 })).toEqual(['a'])
  })

  it('refuses a node the restart gate itself refuses (no session id / not resumable)', () => {
    expect(planHibernation([base('a', { sessionId: undefined })], NOW, cfg)).toEqual([])
    expect(planHibernation([base('a', { agentId: 'opencode' })], NOW, cfg)).toEqual([])
    expect(planHibernation([base('a', { agentId: undefined })], NOW, cfg)).toEqual([])
  })

  it('excludes unwired, onscreen and already-hibernated nodes', () => {
    expect(planHibernation([base('a', { wired: false })], NOW, cfg)).toEqual([])
    expect(planHibernation([base('a', { offscreen: false })], NOW, cfg)).toEqual([])
    expect(planHibernation([base('a', { hibernated: true })], NOW, cfg)).toEqual([])
  })

  it('empty candidate list → empty', () => {
    expect(planHibernation([], NOW, cfg)).toEqual([])
  })
})
