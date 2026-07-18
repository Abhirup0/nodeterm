import { describe, it, expect } from 'vitest'
import { useProjects } from './projects'

describe('setProjectKanban', () => {
  it('sets the board on the target project and carries it through toWorkspace()', () => {
    useProjects.getState().hydrate({
      version: 2,
      activeProjectId: 'p1',
      projects: [{ id: 'p1', name: 'x', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] }]
    })
    const board = { columns: [{ id: 'c1', title: 'To Do', color: '#0a84ff' }], assignments: [] }
    useProjects.getState().setProjectKanban('p1', board)
    expect(useProjects.getState().getProject('p1')?.kanban).toEqual(board)
    expect(useProjects.getState().toWorkspace().projects[0].kanban).toEqual(board)
  })
})
