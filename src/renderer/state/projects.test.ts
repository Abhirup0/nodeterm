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

describe('toWorkspace', () => {
  // Tripwire for Stage 4a: a project's session binding is RUNTIME-ONLY (resolved by
  // src/renderer/session/session.ts `sessionForProject`). The persisted workspace shape must
  // never gain a session field — workspace.json / project.json are shared across machines and a
  // session id is meaningless anywhere but the machine that minted it. If this fails, someone
  // started persisting the session dimension; that is a design change, not a bug fix.
  it('toWorkspace does not persist any session dimension', () => {
    useProjects.getState().addProject('my-app', '/Users/me/dev/my-app')
    const ws = useProjects.getState().toWorkspace()
    const json = JSON.stringify(ws)
    expect(json).not.toMatch(/"session/i)
  })

  // A relay tab is a LIVE connection to another machine's project, not a workspace on this
  // disk. `project.remote` is runtime-only; toWorkspace must drop the whole project so it can
  // never be written into this client's workspace.json.
  it('excludes remote (relay) projects but keeps normal ones', () => {
    const normal = useProjects.getState().addProject('my-app', '/Users/me/dev/my-app')
    const relay = useProjects.getState().addProject('shared')
    useProjects.setState((s) => ({
      projects: s.projects.map((p) => (p.id === relay.id ? { ...p, remote: true } : p))
    }))
    const ws = useProjects.getState().toWorkspace()
    expect(ws.projects.map((p) => p.id)).toEqual([normal.id])
  })
})

describe('setDinoHighScore', () => {
  it('raises the project record and never lowers it', () => {
    const p = useProjects.getState().addProject('game', '/tmp/game')
    useProjects.getState().setDinoHighScore(p.id, 120)
    expect(useProjects.getState().getProject(p.id)?.dinoHighScore).toBe(120)
    // A lower report (second dino node / stale game) must not shrink the record.
    useProjects.getState().setDinoHighScore(p.id, 40)
    expect(useProjects.getState().getProject(p.id)?.dinoHighScore).toBe(120)
    useProjects.getState().setDinoHighScore(p.id, 200)
    expect(useProjects.getState().getProject(p.id)?.dinoHighScore).toBe(200)
  })

  it('ignores unknown project ids', () => {
    useProjects.getState().setDinoHighScore('nope', 99)
    expect(useProjects.getState().projects).toHaveLength(0)
  })
})
