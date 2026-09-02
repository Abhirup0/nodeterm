// The cwd-less ("inline") canvas has its own file — `userData/inline-projects/<id>.json`, the twin
// of a folder project's `<cwd>/.nodeterm/project.json`.
//
// It used to have none: the whole Project rode inside `workspace.json`, which is ONE file with
// last-writer-wins semantics, so a second app instance sharing this userData could erase a canvas
// that existed nowhere else (measured in #621, which deliberately left the shape alone). These
// tests pin the file layer, the DOWNGRADE contract that keeps the same index readable by an older
// build, and the one rule standing in for a merge between two instances: a lower rev may not
// overwrite a higher one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

let userData: string

const node = (id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  title: id, color: '#fff', group: null, ...over
})
const project = (over: Partial<Project> = {}): Project => ({
  id: 'project-p1', name: 'scratch', color: '#7aa2f7', viewport: { x: 4, y: 5, zoom: 2 },
  nodes: [node('term-1')], ...over
})
const ws = (projects: Project[], active = projects[0]?.id ?? ''): Workspace =>
  ({ version: 2, activeProjectId: active, projects })

const dataFile = (id: string) => path.join(userData, 'inline-projects', `${id}.json`)
const readIndex = async () =>
  JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
const readData = async (id: string) => JSON.parse(await fs.readFile(dataFile(id), 'utf-8'))
const writeIndex = async (index: unknown) =>
  fs.writeFile(path.join(userData, 'workspace.json'), JSON.stringify(index))
const ids = (nodes: CanvasNodeState[]) => nodes.map((n) => n.id)

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-inline-'))
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
})

describe('a cwd-less project gets its own file', () => {
  it('writes userData/inline-projects/<id>.json and round-trips through a fresh store', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({
      kanban: { columns: [{ id: 'c1', title: 'To Do', color: '#8b8' }], assignments: [] }
    })]))

    const file = await readData('project-p1')
    expect(file).toMatchObject({ version: 1, rev: 1, name: 'scratch' })
    expect(ids(file.nodes)).toEqual(['term-1'])
    expect(file.kanban.columns[0].title).toBe('To Do')

    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects).toHaveLength(1)
    expect(loaded.projects[0]).toMatchObject({ id: 'project-p1', name: 'scratch' })
    expect(ids(loaded.projects[0].nodes)).toEqual(['term-1'])
    // The machine-local half moved to the entry (#510), but the project the renderer sees is the
    // same object it always was.
    expect(loaded.projects[0].viewport).toEqual({ x: 4, y: 5, zoom: 2 })
    expect(loaded.projects[0].kanban?.columns[0].title).toBe('To Do')
  })

  it('keeps the machine-local half on the entry and the content in the file', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({
      defaultAccountId: 'acct-9',
      nodes: [node('term-1', { shell: '/bin/fish' })]
    })]))

    const entry = (await readIndex()).entries[0]
    expect(entry).toMatchObject({
      dataFile: true, viewport: { x: 4, y: 5, zoom: 2 }, defaultAccountId: 'acct-9'
    })
    expect(entry.localExec).toEqual({ 'term-1': { shell: '/bin/fish' } })

    // The file is written exec-free, exactly like a git-shared project.json — which is what makes
    // it movable into a repo the day "Set folder…" moves it.
    const file = await readData('project-p1')
    expect(file.nodes[0].shell).toBeUndefined()
    expect(JSON.stringify(file)).not.toContain('acct-9')

    // …and the user's own shell still comes back.
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].nodes[0].shell).toBe('/bin/fish')
    expect(loaded.projects[0].defaultAccountId).toBe('acct-9')
  })

  it('does not churn the file when nothing changed, and bumps rev when it did', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    await store.save(ws([project()]))
    expect((await readData('project-p1')).rev).toBe(1)

    await store.save(ws([project({ nodes: [node('term-1'), node('term-2')] })]))
    expect((await readData('project-p1')).rev).toBe(2)
  })

  it('deletes the data file of a project this store had and the user removed', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project(), project({ id: 'project-p2', name: 'other' })]))
    await store.save(ws([project()]))
    await expect(fs.access(dataFile('project-p2'))).rejects.toThrow()
    await expect(fs.access(dataFile('project-p1'))).resolves.toBeUndefined()
  })

  it('refuses to name a file from a hand-edited id and keeps that entry in the pre-file shape', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: '../../evil' })]))
    const entry = (await readIndex()).entries[0]
    expect(entry.dataFile).toBeUndefined()
    expect(entry.project.nodes).toHaveLength(1)
    expect(await fs.readdir(userData)).not.toContain('evil.json')
    const loaded = await new WorkspaceStore().load()
    expect(ids(loaded.projects[0].nodes)).toEqual(['term-1'])
  })

  it('leaves a folder project and an ssh entry exactly as they were', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-folder-'))
    try {
      const store = new WorkspaceStore()
      await store.save(ws([project({ id: 'project-folder', cwd })]))
      const entry = (await readIndex()).entries[0]
      expect(entry.cwd).toBe(cwd)
      expect(entry.dataFile).toBeUndefined()
      expect(entry.project).toBeUndefined()
      await expect(fs.access(path.join(cwd, '.nodeterm', 'project.json'))).resolves.toBeUndefined()
      await expect(fs.access(path.join(userData, 'inline-projects'))).rejects.toThrow()
    } finally {
      await fs.rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('the downgrade contract (dual-write, one release)', () => {
  it('keeps the whole canvas in the index entry, so a build that ignores `dataFile` still reads it', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ nodes: [node('term-1'), node('term-2')] })]))

    // MEASURED: this is exactly what an older loadV3 sees — it knows only `project`.
    const entry = (await readIndex()).entries[0]
    expect(ids(entry.project.nodes)).toEqual(['term-1', 'term-2'])
    expect(entry.project.viewport).toEqual({ x: 4, y: 5, zoom: 2 })

    // And this build falls back to the same cache when the file is gone.
    await fs.rm(dataFile('project-p1'))
    const loaded = await new WorkspaceStore().load()
    expect(ids(loaded.projects[0].nodes)).toEqual(['term-1', 'term-2'])
  })

  it('never drops an entry carrying fields this build does not know', async () => {
    // The forward half of the same measurement: a NEWER build's entry read by this one. An entry
    // with an unknown ref kind and no content this build recognises must still render — as the
    // labeled grey placeholder every unreadable ref becomes — because the save that follows a
    // silent drop would write it out of the index for good.
    await writeIndex({
      version: 3,
      activeProjectId: 'project-p1',
      entries: [
        {
          id: 'project-p1', name: 'known', color: '#fff',
          dataFile: true, project: project(), futureThing: 7
        },
        { id: 'project-p2', name: 'from the future', color: '#0f0', blobRef: 'blobs/p2.json' }
      ]
    })
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects.map((p) => p.id)).toEqual(['project-p1', 'project-p2'])
    expect(ids(loaded.projects[0].nodes)).toEqual(['term-1'])
    expect(loaded.projects[1]).toMatchObject({ name: 'from the future', unavailable: true })
  })

  it('a placeholder save keeps the ref shape instead of storing the empty canvas', async () => {
    // The data file was unreadable at load (a half-written disk, a permission problem): the entry
    // loads as a placeholder, and the save that follows must not make `nodes: []` the stored truth.
    await writeIndex({
      version: 3,
      activeProjectId: 'project-p1',
      entries: [{ id: 'project-p1', name: 'scratch', color: '#fff', dataFile: true }]
    })
    const store = new WorkspaceStore()
    const loaded = await store.load()
    expect(loaded.projects[0]).toMatchObject({ unavailable: true })
    await store.save(loaded)
    const entry = (await readIndex()).entries[0]
    expect(entry.dataFile).toBe(true)
    expect(entry.project).toBeUndefined()
  })
})

describe('migration from the pre-file shape', () => {
  const legacyIndex = {
    version: 3,
    activeProjectId: 'project-p1',
    entries: [{
      id: 'project-p1', name: 'scratch', color: '#7aa2f7',
      project: { ...project(), nodes: [node('term-1', { shell: '/bin/zsh' })] }
    }]
  }

  it('migrates on the first save, loses nothing, and is idempotent', async () => {
    await writeIndex(legacyIndex)
    const store = new WorkspaceStore()
    const loaded = await store.load()
    expect(loaded.projects[0].nodes[0].shell).toBe('/bin/zsh')
    await store.save(loaded)

    expect((await readData('project-p1')).rev).toBe(1)
    expect((await readIndex()).entries[0].dataFile).toBe(true)

    const again = await new WorkspaceStore().load()
    expect(again.projects[0]).toMatchObject({ name: 'scratch', viewport: { x: 4, y: 5, zoom: 2 } })
    expect(again.projects[0].nodes[0].shell).toBe('/bin/zsh')

    await new WorkspaceStore().save(again)
    expect((await readData('project-p1')).rev).toBe(1) // unchanged content, no rewrite
  })

  it('stays consistent when only half of it landed (file written, index write lost)', async () => {
    // The crash window. The index is the only thing that says which KIND an entry is, so a
    // pre-file entry still reads its cache; nothing is corrupt, and the next save reconciles the
    // two copies — both of which were ours.
    await fs.mkdir(path.join(userData, 'inline-projects'), { recursive: true })
    await fs.writeFile(dataFile('project-p1'), JSON.stringify({
      version: 1, rev: 5, savedAt: 'x', name: 'scratch', color: '#7aa2f7',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('term-9')]
    }))
    await writeIndex(legacyIndex)

    const store = new WorkspaceStore()
    const first = await store.load()
    expect(ids(first.projects[0].nodes)).toEqual(['term-1'])
    await store.save(first)

    // The file's rev is ahead of ours, so it is not overwritten and the next load adopts it.
    const after = await new WorkspaceStore().load()
    expect(ids(after.projects[0].nodes)).toEqual(['term-9'])
    expect((await readData('project-p1')).rev).toBe(5)
  })

  it('sidelines a corrupt data file and answers from the index cache', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    await fs.writeFile(dataFile('project-p1'), '{ not json')

    const loaded = await new WorkspaceStore().load()
    expect(ids(loaded.projects[0].nodes)).toEqual(['term-1'])
    const sidelined = (await fs.readdir(path.join(userData, 'inline-projects')))
      .filter((f) => f.includes('.corrupt-'))
    expect(sidelined).toHaveLength(1)
  })
})

describe('two app instances sharing one userData', () => {
  it('the file is the source of truth: a stale index cache never beats it', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    // The other instance advanced the file; our index copy is now stale.
    const file = await readData('project-p1')
    await fs.writeFile(dataFile('project-p1'),
      JSON.stringify({ ...file, rev: 9, nodes: [node('term-other')] }))

    const loaded = await new WorkspaceStore().load()
    expect(ids(loaded.projects[0].nodes)).toEqual(['term-other'])
  })

  it('a lower rev may not overwrite a higher one', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))
    const file = await readData('project-p1')
    await fs.writeFile(dataFile('project-p1'),
      JSON.stringify({ ...file, rev: 9, nodes: [node('term-other')] }))

    await store.save(ws([project({ nodes: [node('term-1'), node('term-2')] })]))
    const after = await readData('project-p1')
    expect(after.rev).toBe(9)
    expect(ids(after.nodes)).toEqual(['term-other'])
  })

  it("an index write that forgets another instance's project no longer destroys its canvas", async () => {
    // THE bug this layer exists for. B loaded an index that did not have A's project yet, so B's
    // next index write drops A's entry (one shared index, last-writer-wins — unchanged). What
    // changed is that A's canvas is still on disk, so it is recoverable rather than gone.
    const b = new WorkspaceStore()
    await b.load()
    const a = new WorkspaceStore()
    await a.load()
    await a.save(ws([project({ id: 'project-a', name: 'A canvas' })]))

    await b.save(ws([project({ id: 'project-b', name: 'B canvas' })]))
    expect((await readIndex()).entries.map((e: { id: string }) => e.id)).toEqual(['project-b'])
    expect((await readData('project-a')).nodes).toHaveLength(1)
  })

  it('an empty canvas never overwrites a populated file the store has not read', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project()]))

    // A store that never loaded — the hydrate race / boot-save shape — saving zero nodes for a
    // project whose file is populated. Its rev is 0, so the rev rule alone would let this through
    // if the file's rev were 0 too; the emptiness rule is what refuses it.
    const neverLoaded = new WorkspaceStore()
    await neverLoaded.save(ws([project({ nodes: [] })], 'project-p1'))
    expect((await readData('project-p1')).nodes).toHaveLength(1)

    // A store that HAS read the file may of course empty the canvas — that is the user deleting
    // their nodes, not a race.
    const loaded = new WorkspaceStore()
    await loaded.load()
    await loaded.save(ws([project({ nodes: [] })], 'project-p1'))
    expect((await readData('project-p1')).nodes).toHaveLength(0)
  })
})
