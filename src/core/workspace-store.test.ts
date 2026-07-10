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
})

describe('probeFolder', () => {
  it('returns the assembled project when the folder has a project file, else null', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const probed = await store.probeFolder(projRoot)
    expect(probed).toMatchObject({ id: 'p1', cwd: projRoot })
    expect(await store.probeFolder(path.join(projRoot, 'nope'))).toBeNull()
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
})
