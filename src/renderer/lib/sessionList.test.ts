import { describe, it, expect } from 'vitest'
import { buildSessionList, sessionStatusKind, type ProjectInput } from './sessionList'
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

describe('buildSessionList', () => {
  it('groups by project with the active project first', () => {
    const groups = buildSessionList(projects(), null, 'p2', {}, '')
    expect(groups.map((g) => g.projectId)).toEqual(['p2', 'p1'])
    expect(groups[0].isActive).toBe(true)
  })

  it('keeps only terminal/agent nodes and flags agents', () => {
    const groups = buildSessionList(projects(), null, 'p1', {}, '')
    const p2 = groups.find((g) => g.projectId === 'p2')!
    expect(p2.sessions.map((s) => s.id)).toEqual(['t2']) // sticky + editor dropped
    const p1 = groups.find((g) => g.projectId === 'p1')!
    expect(p1.sessions.find((s) => s.id === 'a1')!.isAgent).toBe(true)
    expect(p1.sessions.find((s) => s.id === 't1')!.isAgent).toBe(false)
  })

  it('attaches status and unread from the status map', () => {
    const status: Record<string, AgentNodeStatus> = {
      a1: { unread: true, state: 'working', agentId: 'claude', session: 'fix bug', sessionId: 'sess-1' }
    }
    const groups = buildSessionList(projects(), null, 'p1', status, '')
    const a1 = groups[0].sessions.find((s) => s.id === 'a1')!
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
    expect(p1.sessions.map((s) => s.title)).toEqual(['renamed live'])
  })

  it('filters by title and session name, hiding empty groups only when filtering', () => {
    const status: Record<string, AgentNodeStatus> = { a1: { unread: false, session: 'special' } }
    const filtered = buildSessionList(projects(), null, 'p1', status, 'spec')
    expect(filtered.map((g) => g.projectId)).toEqual(['p1'])
    expect(filtered[0].sessions.map((s) => s.id)).toEqual(['a1'])

    const unfiltered = buildSessionList(projects(), null, 'p1', {}, '')
    expect(unfiltered.length).toBe(2) // empty groups kept when no filter
  })
})
