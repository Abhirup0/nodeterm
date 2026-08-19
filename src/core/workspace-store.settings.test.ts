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

describe('project settings — local leg', () => {
  it('write → read round-trips through the store', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    expect(await store.writeProjectSettings('p1', { terminal: { shell: '/bin/zsh' } })).toBe(true)
    const s = await store.readProjectSettings('p1')
    expect(s?.shared?.terminal?.shell).toBe('/bin/zsh')
    const onDisk = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm', 'settings.json'), 'utf-8'))
    expect(onDisk.rev).toBe(1)
  })

  it('a cold store reads before writing, so the rev sequence continues instead of restarting', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await store.writeProjectSettings('p1', { terminal: { shell: '/bin/zsh' } }) // rev 1
    const file = path.join(projRoot, '.nodeterm', 'settings.json')
    expect(JSON.parse(await fs.readFile(file, 'utf-8')).rev).toBe(1)

    // A fresh process: nothing has been read this run, so the write must look at the file first.
    const store2 = new WorkspaceStore()
    await store2.load()
    expect(await store2.writeProjectSettings('p1', { terminal: { shell: '/bin/bash' } })).toBe(true)
    const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'))
    expect(onDisk.rev).toBe(2)
    expect(onDisk.terminal.shell).toBe('/bin/bash')
  })

  it('refuses to write over a git-conflicted settings.json, leaving the bytes untouched', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const file = path.join(projRoot, '.nodeterm', 'settings.json')
    const conflicted = '<<<<<<< a\n{}\n=======\n{}\n>>>>>>> b\n'
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, conflicted, 'utf-8')
    expect(await store.writeProjectSettings('p1', { terminal: { shell: '/bin/zsh' } })).toBe(false)
    expect(await fs.readFile(file, 'utf-8')).toBe(conflicted)
  })

  it('local overlay persists across store instances without a canvas save', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await store.updateLocalProjectSettings('p1', { ignoreShared: { setup: true } })
    const store2 = new WorkspaceStore()
    await store2.load()
    const s = await store2.readProjectSettings('p1')
    expect(s?.local).toEqual({ ignoreShared: { setup: true } })
  })

  it('a canvas save does not drop the overlay (survives splitWorkspace round trip)', async () => {
    const store = new WorkspaceStore()
    const w = ws([project({ cwd: projRoot })])
    await store.save(w)
    await store.updateLocalProjectSettings('p1', { terminal: { shell: '/bin/fish' } })
    await store.save(w) // canvas autosave rebuilds the index
    const idx = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(idx.entries[0].localSettings).toEqual({ terminal: { shell: '/bin/fish' } })
  })

  it('clearing the overlay removes it from the index', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const idxPath = path.join(userData, 'workspace.json')
    await store.updateLocalProjectSettings('p1', { terminal: { shell: '/bin/fish' } })
    const set = JSON.parse(await fs.readFile(idxPath, 'utf-8'))
    expect(set.entries[0].localSettings).toEqual({ terminal: { shell: '/bin/fish' } })
    await store.updateLocalProjectSettings('p1', undefined)
    const idx = JSON.parse(await fs.readFile(idxPath, 'utf-8'))
    expect(idx.entries[0].localSettings).toBeUndefined()
    const s = await store.readProjectSettings('p1')
    expect(s?.local).toBeUndefined()
  })

  it('a git-conflicted settings.json reads as conflict with shared null', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(path.join(projRoot, '.nodeterm', 'settings.json'),
      '<<<<<<< a\n{}\n=======\n{}\n>>>>>>> b\n', 'utf-8')
    const s = await store.readProjectSettings('p1')
    expect(s?.conflict).toBe(true)
    expect(s?.shared).toBeNull()
  })

  it('an inline (cwd-less) project has no shared doc and cannot be written to', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: 'inline1', name: 'inline' })]))
    await store.updateLocalProjectSettings('inline1', { terminal: { theme: 'dark' } })
    const s = await store.readProjectSettings('inline1')
    expect(s?.shared).toBeNull()
    expect(s?.local).toEqual({ terminal: { theme: 'dark' } })
    expect(await store.writeProjectSettings('inline1', { terminal: { shell: '/bin/zsh' } })).toBe(false)
  })

  it('returns null for an unknown project id', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    expect(await store.readProjectSettings('nope')).toBeNull()
    expect(await store.writeProjectSettings('nope', {})).toBe(false)
    expect(await store.updateLocalProjectSettings('nope', {})).toBe(false)
  })

  it('a hostile localSettings shape in workspace.json is sanitized on load', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const idxPath = path.join(userData, 'workspace.json')
    const idx = JSON.parse(await fs.readFile(idxPath, 'utf-8'))
    // JSON.parse (not an object literal): only the parser creates `__proto__` as a real OWN
    // property — a literal would set the prototype and the key would never reach the file.
    idx.entries[0].localSettings = JSON.parse('{"agents":{"env":{"__proto__":"x","OK":"v"}},"bogus":1}')
    const rawIndex = JSON.stringify(idx)
    expect(rawIndex).toContain('__proto__') // the hostile key really is on disk
    await fs.writeFile(idxPath, rawIndex, 'utf-8')
    const store2 = new WorkspaceStore()
    await store2.load()
    const s = await store2.readProjectSettings('p1')
    expect(s?.local).toEqual({ agents: { env: { OK: 'v' } } })
  })

  it('a hostile settingsCache in workspace.json is rejected on load', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([
      project({ id: 'ssh1', name: 'remote', ssh: { server: { host: 'h', user: 'u' }, remoteCwd: '~/x' } })
    ]))
    const idxPath = path.join(userData, 'workspace.json')
    const idx = JSON.parse(await fs.readFile(idxPath, 'utf-8'))
    idx.entries[0].settingsCache = { version: 2, rev: 'nope', terminal: { shell: '/bin/evil' } }
    await fs.writeFile(idxPath, JSON.stringify(idx), 'utf-8')
    const store2 = new WorkspaceStore()
    await store2.load()
    const s = await store2.readProjectSettings('ssh1')
    expect(s?.shared).toBeNull()
  })
})
