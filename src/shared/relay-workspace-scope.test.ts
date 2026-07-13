import { describe, it, expect } from 'vitest'
import { scopeWorkspaceToProject } from './relay-workspace-scope'
import type { Project, Workspace } from './types'

const project = (id: string): Project => ({
  id,
  name: id,
  color: '#fff',
  nodes: [],
  viewport: { x: 0, y: 0, zoom: 1 }
})

const ws = (): Workspace => ({
  version: 2,
  activeProjectId: 'a',
  projects: [project('a'), project('b'), project('c')]
})

describe('scopeWorkspaceToProject', () => {
  it('keeps only the named project and points activeProjectId at it', () => {
    const scoped = scopeWorkspaceToProject(ws(), 'b')
    expect(scoped.projects.map((p) => p.id)).toEqual(['b'])
    expect(scoped.activeProjectId).toBe('b')
  })

  it('returns an empty-projects workspace when the id is gone', () => {
    const scoped = scopeWorkspaceToProject(ws(), 'missing')
    expect(scoped.projects).toEqual([])
    expect(scoped.activeProjectId).toBe('')
  })

  it('preserves every other top-level workspace field as-is', () => {
    const scoped = scopeWorkspaceToProject(ws(), 'b')
    expect(scoped.version).toBe(2)
  })

  it('does not mutate the input workspace', () => {
    const input = ws()
    scopeWorkspaceToProject(input, 'b')
    expect(input.projects.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(input.activeProjectId).toBe('a')
  })
})
