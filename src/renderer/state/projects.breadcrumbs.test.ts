import { describe, it, expect, beforeEach } from 'vitest'
import { useProjects } from './projects'

const baseProject = {
  id: 'p1',
  name: 'p',
  color: '#fff',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: []
}

describe('setProjectBreadcrumbs', () => {
  beforeEach(() => {
    useProjects.getState().hydrate({
      version: 2,
      activeProjectId: 'p1',
      projects: [{ ...baseProject }]
    })
  })

  it("replaces the project's breadcrumb list", () => {
    const stop = { nodeId: 'n1', at: 1000, note: 'terminal · t' }
    useProjects.getState().setProjectBreadcrumbs('p1', [stop])
    expect(useProjects.getState().getProject('p1')?.breadcrumbs).toEqual([stop])
  })

  it('is a no-op for an unknown project id', () => {
    useProjects.getState().setProjectBreadcrumbs('nope', [{ nodeId: 'n1', at: 1, note: '' }])
    expect(useProjects.getState().getProject('p1')?.breadcrumbs).toBeUndefined()
  })
})
