import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import { CLOSED_SESSIONS_CAP } from '../shared/types'
import type { Project, Workspace } from '../shared/types'

let userData: string
let projRoot: string

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
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  await fs.rm(projRoot, { recursive: true, force: true })
})

describe('closedAt round trip (machine-local index)', () => {
  it('persists closedAt on the index entry and never on the shared project file', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot, closed: true, closedAt: 12345 })]))

    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].closed).toBe(true)
    expect(index.entries[0].closedAt).toBe(12345)

    const file = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8'))
    expect(file.closedAt).toBeUndefined()

    const loaded = await store.load()
    expect(loaded.projects[0].closed).toBe(true)
    expect(loaded.projects[0].closedAt).toBe(12345)
  })

  it('omits closedAt from the index when the project was never closed', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].closedAt).toBeUndefined()
  })
})

/**
 * An INLINE (cwd-less) project is stored verbatim in workspace.json and never passes through
 * `fileToProject`, so it bypasses every guard that lives there. The branch already re-applies
 * `validKanban` and `sanitizeNodeTriggers` for exactly this reason ("workspace.json is
 * hand-editable input too") — `closedSessions` owes the same, or a malformed value reaches
 * `mergeClosedHistory`, which iterates it (a non-array throws and takes the sidebar render down)
 * and hands each node to React Flow.
 */
describe('inline (cwd-less) projects sanitize closedSessions on load', () => {
  const writeIndex = async (entries: unknown[]): Promise<void> => {
    await fs.writeFile(
      path.join(userData, 'workspace.json'),
      JSON.stringify({ version: 3, activeProjectId: 'p1', entries }),
      'utf-8'
    )
  }
  const inline = (closedSessions: unknown) => [
    {
      id: 'p1',
      name: 'foo',
      color: '#7aa2f7',
      project: {
        id: 'p1', name: 'foo', color: '#7aa2f7',
        viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
        closedSessions
      }
    }
  ]

  it('drops a non-array closedSessions rather than letting it reach the sidebar', async () => {
    await writeIndex(inline({ not: 'an array' }))
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].closedSessions).toBeUndefined()
  })

  it('drops entries with no position data (the recreate-time crash shape)', async () => {
    await writeIndex(
      inline([
        {
          id: 'e1', closedAt: 1,
          node: { id: 'n1', kind: 'terminal', title: 't', color: '#fff', group: null }
        }
      ])
    )
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].closedSessions).toBeUndefined()
  })

  it('keeps a well-formed entry but strips a trigger spec off its node, same as live nodes', async () => {
    await writeIndex(
      inline([
        {
          id: 'e1', closedAt: 1,
          absolutePosition: { x: 0, y: 0 },
          node: {
            id: 'n1', kind: 'terminal', position: { x: 0, y: 0 },
            size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null,
            // A spec on a NON-trigger node — sanitizeNodeTriggers drops it outright.
            trigger: { kind: 'cron', expr: '* * * * *' }
          }
        }
      ])
    )
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].closedSessions).toHaveLength(1)
    expect(loaded.projects[0].closedSessions?.[0].node.trigger).toBeUndefined()
    expect(loaded.projects[0].closedSessions?.[0].node.title).toBe('t')
  })

  it('caps an oversized inline history', async () => {
    await writeIndex(
      inline(
        Array.from({ length: CLOSED_SESSIONS_CAP + 5 }, (_, i) => ({
          id: `e${i}`, closedAt: i,
          absolutePosition: { x: 0, y: 0 },
          node: {
            id: `n${i}`, kind: 'terminal', position: { x: 0, y: 0 },
            size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null
          }
        }))
      )
    )
    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].closedSessions).toHaveLength(CLOSED_SESSIONS_CAP)
  })
})
