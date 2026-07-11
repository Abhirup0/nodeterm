import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import type { Project, Workspace } from '../shared/types'

let userData: string
let projRoot: string
let fake: ReturnType<typeof fakePlatform>

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [{ id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null }],
  ...over
})
const ws = (projects: Project[], active = projects[0]?.id ?? ''): Workspace =>
  ({ version: 2, activeProjectId: active, projects })

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ws-'))
  projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-proj-'))
  fake = fakePlatform({ userDataDir: userData })
  initPlatform(fake)
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  await fs.rm(projRoot, { recursive: true, force: true })
})

describe('save → load round trip (v3)', () => {
  it('writes <cwd>/.nodeterm/project.json + a v3 index, and loads it back assembled', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot }), project({ id: 'p2', name: 'inline' })]))
    const file = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    expect(file).toMatchObject({ version: 1, id: 'p1', rev: 1 })
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.version).toBe(3)
    expect(index.entries[0].cwd).toBe(projRoot)
    expect(index.entries[0].project).toBeUndefined()
    const loaded = await new WorkspaceStore().load()
    expect(loaded.version).toBe(2) // in-memory contract stays v2-shaped
    expect(loaded.projects[0]).toMatchObject({ id: 'p1', cwd: projRoot })
    expect(loaded.projects[0].nodes[0].id).toBe('term-1')
    expect(loaded.projects[1]).toMatchObject({ id: 'p2', name: 'inline' })
  })

  it('does not rewrite (or bump rev of) an unchanged project file', async () => {
    const store = new WorkspaceStore()
    const w = ws([project({ cwd: projRoot })])
    await store.save(w)
    const p = path.join(projRoot, '.nodeterm/project.json')
    const first = await fs.readFile(p, 'utf-8')
    await store.save(w)
    expect(await fs.readFile(p, 'utf-8')).toBe(first) // same rev, same bytes
    await store.save(ws([{ ...w.projects[0], name: 'renamed' }]))
    expect(JSON.parse(await fs.readFile(p, 'utf-8'))).toMatchObject({ rev: 2, name: 'renamed' })
  })
})

describe('v2 → v3 migration', () => {
  it('assembles a v2 file on load, then the first save migrates: project files + v3 index + .bak + broadcast', async () => {
    const legacy = ws([project({ cwd: projRoot })])
    await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify(legacy))
    const store = new WorkspaceStore()
    const loaded = await store.load()
    expect(loaded.projects[0].id).toBe('p1')
    await store.save(loaded)
    expect(JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8')).version).toBe(3)
    expect(JSON.parse(await fs.readFile(path.join(userData, 'workspace.v2.bak'), 'utf-8')).version).toBe(2)
    expect((await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))).toContain('"id": "p1"')
    expect(fake.sent.some((s) => s.channel === 'workspace:migrated')).toBe(true)
  })

  it('is idempotent: loading + saving v3 again writes no .bak twice and keeps data', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await fs.rm(path.join(userData, 'workspace.v2.bak'), { force: true })
    const again = new WorkspaceStore()
    await again.save(await again.load())
    await expect(fs.access(path.join(userData, 'workspace.v2.bak'))).rejects.toThrow()
  })
})

describe('unavailable & corrupt refs', () => {
  it('marks a ref with a missing folder unavailable (kept, greyed) instead of dropping it', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await fs.rm(projRoot, { recursive: true, force: true })
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0]).toMatchObject({ id: 'p1', name: 'foo', unavailable: true, nodes: [] })
  })

  it('sets aside a corrupt project file and marks the project unavailable', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const p = path.join(projRoot, '.nodeterm/project.json')
    await fs.writeFile(p, '{ not json')
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].unavailable).toBe(true)
    const dir = await fs.readdir(path.join(projRoot, '.nodeterm'))
    expect(dir.some((f) => f.startsWith('project.json.corrupt-'))).toBe(true)
  })

  it('sets aside a valid-JSON but wrong-shape project file and marks it unavailable', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const p = path.join(projRoot, '.nodeterm/project.json')
    await fs.writeFile(p, '{"version": 99}') // parses, but not a ProjectFileV1
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].unavailable).toBe(true)
    const dir = await fs.readdir(path.join(projRoot, '.nodeterm'))
    expect(dir.some((f) => f.startsWith('project.json.corrupt-'))).toBe(true)
  })

  it('load({ sideline: false }) marks a corrupt ref unavailable WITHOUT sidelining it', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const p = path.join(projRoot, '.nodeterm/project.json')
    await fs.writeFile(p, '{ not json') // e.g. a git-conflict-marked file mid-merge
    const loaded = await new WorkspaceStore().load({ sideline: false })
    expect(loaded.projects[0].unavailable).toBe(true)
    const dir = await fs.readdir(path.join(projRoot, '.nodeterm'))
    expect(dir.some((f) => f.startsWith('project.json.corrupt-'))).toBe(false) // left in place
  })
})

describe('unavailable projects never overwrite real data on save', () => {
  it('save() of an unavailable local project does not touch the project file', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const p = path.join(projRoot, '.nodeterm/project.json')
    const original = await fs.readFile(p, 'utf-8')
    // Folder goes missing at load → placeholder with nodes: []
    await fs.rm(projRoot, { recursive: true, force: true })
    const store2 = new WorkspaceStore()
    const loaded = await store2.load()
    expect(loaded.projects[0].unavailable).toBe(true)
    // Disk comes back with the real file (remounted / restored checkout) before the next save
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(p, original, 'utf-8')
    await store2.save(loaded)
    expect(await fs.readFile(p, 'utf-8')).toBe(original) // untouched — no nodes:[] overwrite
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].cwd).toBe(projRoot) // entry still refs the cwd
  })

  it('save() of an unavailable ssh project preserves the previous cache verbatim', async () => {
    // Chosen construction: seed a populated ssh cache in the index (so it loads fine), then
    // hand-mark the loaded project unavailable before save — the real data-loss scenario is
    // the placeholder replacing a *good* offline cache.
    const cache = {
      version: 1, rev: 5, savedAt: '2026-01-01T00:00:00.000Z',
      id: 's1', name: 'remote', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{ id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null }]
    }
    const index = {
      version: 3, activeProjectId: 's1',
      entries: [{ id: 's1', name: 'remote', color: '#7aa2f7', ssh: { server: { host: 'h', user: 'u' }, remoteCwd: '~/app' }, cache }]
    }
    await fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify(index))
    const store = new WorkspaceStore()
    const loaded = await store.load()
    expect(loaded.projects[0].unavailable).toBeFalsy() // cache-backed → loads fine
    // Simulate the ref becoming unavailable in memory (e.g. server unreachable next cycle)
    loaded.projects[0] = { ...loaded.projects[0], unavailable: true, nodes: [] }
    await store.save(loaded)
    const after = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(after.entries[0].cache).toEqual(cache) // good offline cache survived verbatim
  })
})

describe('probeFolder', () => {
  it('returns the assembled project when the folder has a project file, else null', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const probed = await store.probeFolder(projRoot)
    expect(probed).toMatchObject({ id: 'p1', cwd: projRoot })
    expect(await store.probeFolder(path.join(projRoot, 'nope'))).toBeNull()
  })

  it('is read-only: a corrupt file returns null WITHOUT sidelining it (arbitrary-path RPC)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const p = path.join(projRoot, '.nodeterm/project.json')
    await fs.writeFile(p, '{ not json')
    expect(await store.probeFolder(projRoot)).toBeNull()
    expect(await fs.readFile(p, 'utf-8')).toBe('{ not json') // untouched
    const dir = await fs.readdir(path.join(projRoot, '.nodeterm'))
    expect(dir.some((f) => f.startsWith('project.json.corrupt-'))).toBe(false) // no sideline
  })
})

describe('readLocalRefByPath', () => {
  it('maps a watched project.json path back to its project; unknown path → null', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const filePath = path.join(projRoot, '.nodeterm/project.json')
    const p = await store.readLocalRefByPath(filePath)
    expect(p).toMatchObject({ id: 'p1', cwd: projRoot })
    expect(await store.readLocalRefByPath(path.join(projRoot, 'nope/project.json'))).toBeNull()
  })

  it('leaves a git-conflict-marked file in place (mid-merge is hand-resolvable, never sidelined)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const filePath = path.join(projRoot, '.nodeterm/project.json')
    const conflicted = '<<<<<<< HEAD\n{"version":1}\n=======\n{"version":1}\n>>>>>>> theirs\n'
    await fs.writeFile(filePath, conflicted)
    expect(await store.readLocalRefByPath(filePath)).toBeNull() // unparsable → no project
    expect(await fs.readFile(filePath, 'utf-8')).toBe(conflicted) // but left in place
    const dir = await fs.readdir(path.join(projRoot, '.nodeterm'))
    expect(dir.some((f) => f.startsWith('project.json.corrupt-'))).toBe(false)
  })
})

describe('same-cwd projects survive a save → load round trip', () => {
  it('two tabs on one folder both come back (first file-backed, second inline)', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: 'a', name: 'first', cwd: projRoot }), project({ id: 'b', name: 'second', cwd: projRoot })]))
    // Only one file exists on disk; the second is inline in the index.
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries.filter((e: any) => e.cwd).length).toBe(1)
    expect(index.entries.find((e: any) => e.project)?.project.id).toBe('b')
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects.map((p) => p.id).sort()).toEqual(['a', 'b'])
    expect(loaded.projects.find((p) => p.id === 'a')).toMatchObject({ name: 'first', cwd: projRoot })
    expect(loaded.projects.find((p) => p.id === 'b')).toMatchObject({ name: 'second' })
  })
})

describe('projects.list relay blob (iOS wire contract)', () => {
  it('the blob JSON.stringify(load()) parses as {version:2, projects:[…]} even when the file is v3', async () => {
    // Seed a real v3 tree on disk (file-backed local ref), as listProjectsOutput sees it.
    await new WorkspaceStore().save(ws([project({ cwd: projRoot })]))
    const onDisk = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(onDisk.version).toBe(3) // the raw file the OLD blob shipped

    // listProjectsOutput now serves JSON.stringify(await workspaceStore.load()).
    const blob = JSON.stringify(await new WorkspaceStore().load())
    const parsed = JSON.parse(blob)
    expect(parsed.version).toBe(2)
    expect(Array.isArray(parsed.projects)).toBe(true)
    expect(parsed.projects[0]).toMatchObject({ id: 'p1', cwd: projRoot })
    expect(parsed.projects[0].nodes[0].id).toBe('term-1') // node data present (not in the v3 file)
  })
})

describe('refreshSshProject', () => {
  const sshConn = { server: { host: 'h', user: 'u' } as any, remoteCwd: '~/app' }
  const remoteFileOf = async (store: WorkspaceStore, p: Project) => {
    // seed: one ssh project saved → cache rev 1
    await store.save(ws([p]))
  }

  it('remote rev > cache rev → adopts remote and reports it', async () => {
    const remote: Record<string, string> = {}
    const io = {
      read: async (id: string) => remote[id] ?? null,
      write: async (id: string, _s: any, c: string) => ((remote[id] = c), true)
    }
    const store = new WorkspaceStore(io)
    const p = project({ id: 'ps', ssh: sshConn, cwd: undefined })
    await remoteFileOf(store, p)                    // cache rev 1, mirrored to remote
    const newer = JSON.parse(remote['ps'])
    newer.rev = 5; newer.name = 'server-renamed'
    remote['ps'] = JSON.stringify(newer)
    const adopted = await store.refreshSshProject('ps')
    expect(adopted).toMatchObject({ id: 'ps', name: 'server-renamed' })
  })

  it('cache rev >= remote rev → pushes the cache up instead and returns null', async () => {
    const remote: Record<string, string> = {}
    const writes: string[] = []
    const io = {
      read: async (id: string) => remote[id] ?? null,
      write: async (id: string, _s: any, c: string) => (writes.push(id), (remote[id] = c), true)
    }
    const store = new WorkspaceStore(io)
    await remoteFileOf(store, project({ id: 'ps', ssh: sshConn, cwd: undefined }))
    const older = JSON.parse(remote['ps'])
    older.rev = 0
    remote['ps'] = JSON.stringify(older)
    expect(await store.refreshSshProject('ps')).toBeNull()
    expect(writes.filter((w) => w === 'ps').length).toBeGreaterThanOrEqual(2) // seed + push-up
  })

  it('no remote file yet → pushes the cache up (first machine wins)', async () => {
    const remote: Record<string, string> = {}
    const io = { read: async () => null, write: async (id: string, _s: any, c: string) => ((remote[id] = c), true) }
    const store = new WorkspaceStore(io)
    await remoteFileOf(store, project({ id: 'ps', ssh: sshConn, cwd: undefined }))
    expect(await store.refreshSshProject('ps')).toBeNull()
    expect(remote['ps']).toContain('"id": "ps"')
  })
})
