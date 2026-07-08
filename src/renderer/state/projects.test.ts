import { describe, it, expect, beforeEach } from 'vitest'
import { useProjects } from './projects'

beforeEach(() => {
  useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
})

describe('openFolderProject', () => {
  it('creates a new project named after the folder and activates it', () => {
    const p = useProjects.getState().openFolderProject('/Users/me/dev/my-app')
    expect(p.name).toBe('my-app')
    expect(p.cwd).toBe('/Users/me/dev/my-app')
    const s = useProjects.getState()
    expect(s.activeProjectId).toBe(p.id)
    expect(s.projects.filter((q) => !q.closed)).toHaveLength(1)
  })

  it('reuses an existing open project with the same folder instead of duplicating', () => {
    const first = useProjects.getState().addProject('my-app', '/Users/me/dev/my-app')
    const p = useProjects.getState().openFolderProject('/Users/me/dev/my-app')
    expect(p.id).toBe(first.id)
    expect(useProjects.getState().projects).toHaveLength(1)
    expect(useProjects.getState().activeProjectId).toBe(first.id)
  })

  // Regression: "Open folder" on a folder whose project was previously closed used to
  // activate the still-closed project — the canvas switched to it but the tab bar and
  // sidebar (which filter `closed`) showed nothing.
  it('reopens a closed project with the same folder so it is visible again', () => {
    const first = useProjects.getState().addProject('my-app', '/Users/me/dev/my-app')
    useProjects.getState().closeProject(first.id)
    expect(useProjects.getState().projects.filter((q) => !q.closed)).toHaveLength(0)

    const p = useProjects.getState().openFolderProject('/Users/me/dev/my-app')
    expect(p.id).toBe(first.id)
    const s = useProjects.getState()
    expect(s.activeProjectId).toBe(first.id)
    expect(s.projects.filter((q) => !q.closed).map((q) => q.id)).toEqual([first.id])
  })

  it('falls back to a generic name for a root-ish folder', () => {
    const p = useProjects.getState().openFolderProject('/')
    expect(p.name).toBe('Project')
  })
})
