import { describe, it, expect } from 'vitest'
import {
  buildSessionList,
  sessionStatusKind,
  isGroupCollapsed,
  projectHeadClickAction,
  projectSignalCounts,
  type ProjectInput,
  type SessionRowVM,
  type SessionGroup
} from './sessionList'
import type { AgentNodeStatus } from '../state/agentStatus'

const node = (id: string, over: Partial<ProjectInput['nodes'][number]> = {}) => ({
  id,
  kind: 'terminal' as const,
  title: id,
  color: '#888',
  ...over
})

const projects = (): ProjectInput[] => [
  { id: 'p1', name: 'Alpha', color: '#111', cwd: '/a', nodes: [node('t1'), node('a1', { agentId: 'claude' })] },
  { id: 'p2', name: 'Beta', color: '#222', nodes: [node('t2'), node('s1', { kind: 'sticky' }), node('e1', { kind: 'editor' })] }
]

describe('sessionStatusKind', () => {
  it('maps agent states to status kinds', () => {
    expect(sessionStatusKind('working')).toBe('working')
    expect(sessionStatusKind('waiting')).toBe('attention')
    expect(sessionStatusKind('blocked')).toBe('attention')
    expect(sessionStatusKind('done')).toBe('done')
    expect(sessionStatusKind(undefined)).toBe('idle')
  })
})

describe('isGroupCollapsed', () => {
  it('defaults to expanded for the active project and collapsed for the rest', () => {
    expect(isGroupCollapsed({}, 'p1', true)).toBe(false)
    expect(isGroupCollapsed({}, 'p2', false)).toBe(true)
  })

  it('lets an explicit override win over the default', () => {
    expect(isGroupCollapsed({ p1: true }, 'p1', true)).toBe(true) // active but user collapsed
    expect(isGroupCollapsed({ p2: false }, 'p2', false)).toBe(false) // inactive but user expanded
  })

  it('with autoCollapse off, everything defaults to expanded (overrides still win)', () => {
    expect(isGroupCollapsed({}, 'p1', true, false)).toBe(false)
    expect(isGroupCollapsed({}, 'p2', false, false)).toBe(false) // inactive stays expanded
    expect(isGroupCollapsed({ p2: true }, 'p2', false, false)).toBe(true) // user collapsed
  })
})

describe('projectHeadClickAction', () => {
  it('switches to an inactive project and toggles the active one (never both, never nothing)', () => {
    expect(projectHeadClickAction(false)).toBe('switch')
    // No dead zone: the active row still does what the whole header used to do.
    expect(projectHeadClickAction(true)).toBe('toggle-collapse')
  })

  it('needs no collapse write on a switch: the target expands from the DEFAULT', () => {
    // With autoCollapse ON the sidebar wipes every override on the activeProjectId change, so
    // a toggle written by the click would be clobbered a tick later anyway — and is pointless,
    // because the newly active project is expanded by the default rule.
    expect(projectHeadClickAction(false)).toBe('switch')
    expect(isGroupCollapsed({}, 'p2', true)).toBe(false)
  })

  it("with autoCollapse off, a switch leaves the target's explicit collapse choice alone", () => {
    // Documented contract: "off = switches never touch the user's choices". The click writes no
    // override, so a project the user collapsed by hand stays collapsed after switching to it.
    const overrides = { p2: true }
    expect(projectHeadClickAction(false)).toBe('switch')
    expect(isGroupCollapsed(overrides, 'p2', true, false)).toBe(true)
  })
})

describe('buildSessionList', () => {
  it('keeps store order (mirrors the tab bar) regardless of which project is active', () => {
    const groups = buildSessionList(projects(), null, 'p2', {}, '')
    expect(groups.map((g) => g.projectId)).toEqual(['p1', 'p2'])
    expect(groups.find((g) => g.projectId === 'p2')!.isActive).toBe(true)
  })

  it('keeps only terminal/agent nodes and flags agents', () => {
    const groups = buildSessionList(projects(), null, 'p1', {}, '')
    const p2 = groups.find((g) => g.projectId === 'p2')!
    expect(p2.ungrouped.map((s) => s.id)).toEqual(['t2']) // sticky + editor dropped
    const p1 = groups.find((g) => g.projectId === 'p1')!
    expect(p1.ungrouped.find((s) => s.id === 'a1')!.isAgent).toBe(true)
    expect(p1.ungrouped.find((s) => s.id === 't1')!.isAgent).toBe(false)
  })

  it('attaches status and unread from the status map', () => {
    const status: Record<string, AgentNodeStatus> = {
      a1: { unread: true, state: 'working', agentId: 'claude', session: 'fix bug', sessionId: 'sess-1' }
    }
    const groups = buildSessionList(projects(), null, 'p1', status, '')
    const a1 = groups[0].ungrouped.find((s) => s.id === 'a1')!
    expect(a1.statusKind).toBe('working')
    expect(a1.unread).toBe(true)
    expect(a1.session).toBe('fix bug')
    expect(a1.sessionId).toBe('sess-1')
    expect(a1.usesContext).toBe(true) // claude is USAGE_CAPABLE
  })

  it('uses live nodes for the active project instead of serialized ones', () => {
    const live = [node('t1', { title: 'renamed live' })]
    const groups = buildSessionList(projects(), live, 'p1', {}, '')
    const p1 = groups.find((g) => g.projectId === 'p1')!
    expect(p1.ungrouped.map((s) => s.title)).toEqual(['renamed live'])
  })

  it('nests sessions under their canvas group and separates ungrouped ones', () => {
    const proj: ProjectInput[] = [
      {
        id: 'p1',
        name: 'Alpha',
        color: '#111',
        nodes: [
          node('g1', { kind: 'group', title: 'Frontend', color: '#abc' }),
          node('t1', { parentId: 'g1' }),
          node('t2', { parentId: 'g1' }),
          node('t3'), // ungrouped
          node('t4', { parentId: 'missing' }) // dangling parent → ungrouped
        ]
      }
    ]
    const [p1] = buildSessionList(proj, null, 'p1', {}, '')
    expect(p1.groups).toHaveLength(1)
    expect(p1.groups[0]).toMatchObject({ id: 'g1', title: 'Frontend', color: '#abc' })
    expect(p1.groups[0].sessions.map((s) => s.id)).toEqual(['t1', 't2'])
    expect(p1.ungrouped.map((s) => s.id)).toEqual(['t3', 't4'])
  })

  it('keeps empty groups without a filter and hides them when filtering', () => {
    const proj: ProjectInput[] = [
      {
        id: 'p1',
        name: 'Alpha',
        color: '#111',
        nodes: [
          node('g1', { kind: 'group', title: 'Empty', color: '#abc' }),
          node('g2', { kind: 'group', title: 'Has match', color: '#def' }),
          node('t1', { title: 'special', parentId: 'g2' })
        ]
      }
    ]
    const unfiltered = buildSessionList(proj, null, 'p1', {}, '')
    expect(unfiltered[0].groups.map((b) => b.id)).toEqual(['g1', 'g2']) // empty g1 kept

    const filtered = buildSessionList(proj, null, 'p1', {}, 'spec')
    expect(filtered[0].groups.map((b) => b.id)).toEqual(['g2']) // empty g1 dropped
    expect(filtered[0].groups[0].sessions.map((s) => s.id)).toEqual(['t1'])
  })

  it('filters by title and session name, hiding empty projects only when filtering', () => {
    const status: Record<string, AgentNodeStatus> = { a1: { unread: false, session: 'special' } }
    const filtered = buildSessionList(projects(), null, 'p1', status, 'spec')
    expect(filtered.map((g) => g.projectId)).toEqual(['p1'])
    expect(filtered[0].ungrouped.map((s) => s.id)).toEqual(['a1'])

    const unfiltered = buildSessionList(projects(), null, 'p1', {}, '')
    expect(unfiltered.length).toBe(2) // both projects kept when no filter
  })
})

describe('projectSignalCounts', () => {
  const group = (sessions: Partial<SessionRowVM>[]): SessionGroup => ({
    projectId: 'p1',
    projectName: 'P',
    projectColor: '#111',
    isActive: false,
    groups: [],
    ungrouped: sessions.map((s, i) => ({
      id: `s${i}`,
      title: `s${i}`,
      color: '#888',
      isAgent: false,
      statusKind: 'idle' as const,
      stateLabel: 'Idle',
      unread: false,
      usesContext: false,
      ...s
    }))
  })

  // Restored from before the working badge: the original a–f matrix. It pins the row-glyph
  // PRECEDENCE (attention beats unread, a working session is not yet unread) across both
  // ungrouped and grouped sessions, which the narrower fixtures below do not reach. The working
  // count is asserted alongside it rather than replacing it.
  it('counts attention and unread across ungrouped and grouped sessions', () => {
    const proj: ProjectInput[] = [
      {
        id: 'p1',
        name: 'P1',
        color: '#123',
        nodes: [
          node('g1', { kind: 'group', title: 'G', color: '#abc' }),
          node('a'), // waiting → attention
          node('b', { parentId: 'g1' }), // blocked → attention
          node('c'), // done + unread → unread
          node('d'), // idle + unread → unread (state lost, unread persisted)
          node('e'), // working + unread → NOT counted (mirrors the row glyph precedence)
          node('f') // plain idle → neither
        ]
      }
    ]
    const status: Record<string, AgentNodeStatus> = {
      a: { unread: false, state: 'waiting' },
      b: { unread: true, state: 'blocked' }, // attention wins over unread
      c: { unread: true, state: 'done' },
      d: { unread: true },
      e: { unread: true, state: 'working' }
    }
    const [g] = buildSessionList(proj, null, 'p1', status, '')
    // `e` is the load-bearing one: it is the single working session AND carries an unread mark,
    // so it must land in `working` and NOT in `unread`.
    expect(projectSignalCounts(g)).toEqual({ attention: 2, unread: 2, working: 1 })
  })

  it('returns zeros for a quiet project', () => {
    const [g] = buildSessionList(
      [{ id: 'p1', name: 'P1', color: '#123', nodes: [node('x')] }],
      null,
      'p1',
      {},
      ''
    )
    expect(projectSignalCounts(g)).toEqual({ attention: 0, unread: 0, working: 0 })
  })

  it('counts working sessions alongside attention/unread', () => {
    const g = group([
      { statusKind: 'working' },
      { statusKind: 'working' },
      { statusKind: 'attention' },
      { statusKind: 'idle' }
    ])
    expect(projectSignalCounts(g)).toEqual({ attention: 1, unread: 0, working: 2 })
  })

  it('working is 0 when nothing is running, and unread is counted when not working', () => {
    const g = group([{ statusKind: 'idle' }, { statusKind: 'done', unread: true }])
    expect(projectSignalCounts(g)).toEqual({ attention: 0, unread: 1, working: 0 })
  })

  it('drives through buildSessionList: counts grouped sessions, attention wins over unread, working is not double-counted as unread', () => {
    const proj: ProjectInput[] = [
      {
        id: 'p1',
        name: 'Alpha',
        color: '#111',
        nodes: [
          node('g1', { kind: 'group', title: 'Frontend', color: '#abc' }),
          node('a1', { agentId: 'claude', parentId: 'g1' }), // attention + unread -> attention only
          node('a2', { agentId: 'claude', parentId: 'g1' }), // working + unread -> working only
          node('t1') // ungrouped, idle
        ]
      }
    ]
    const status: Record<string, AgentNodeStatus> = {
      a1: { unread: true, state: 'blocked', agentId: 'claude', session: 'blocked task', sessionId: 'sess-a1' },
      a2: { unread: true, state: 'working', agentId: 'claude', session: 'working task', sessionId: 'sess-a2' }
    }
    const [p1] = buildSessionList(proj, null, 'p1', status, '')
    expect(p1.groups[0].sessions.map((s) => s.id)).toEqual(['a1', 'a2']) // sanity: sessions really live under group.groups
    expect(projectSignalCounts(p1)).toEqual({ attention: 1, unread: 0, working: 1 })
  })
})
