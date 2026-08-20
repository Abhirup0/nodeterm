import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fakePlatform, type FakePlatform } from './platform-fake'
import {
  registerWorktreeSharedPathsHandlers,
  type WorktreeSharedPathsDeps
} from './worktree-shared-paths-handlers'
import { IPC } from '../shared/ipc'
import type { SharedPathResult } from './worktree-shared-paths'
import type { ProjectSettingsSnapshot } from '../shared/project-settings'
import type { WorktreeListResult } from '../shared/worktree'

const materialize = (f: FakePlatform, projectId: unknown, worktreePath: unknown) =>
  f.handlers[IPC.worktreeMaterializeShared](projectId, worktreePath) as Promise<SharedPathResult[]>

// A snapshot whose SHARED doc lists the given sharedPaths — the list the handler must read ITSELF
// by projectId (never a value the renderer passed in).
const snapshotWithSharedPaths = (sharedPaths: string[]): ProjectSettingsSnapshot => ({
  shared: { version: 1, rev: 1, savedAt: '', worktree: { sharedPaths } },
  local: undefined
})

describe('registerWorktreeSharedPathsHandlers', () => {
  let base: string
  let repoRoot: string
  let worktreeRoot: string
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-wt-shared-'))
    repoRoot = path.join(base, 'repo')
    worktreeRoot = path.join(base, 'repo.worktrees', 'feature')
    fs.mkdirSync(repoRoot, { recursive: true })
    fs.mkdirSync(worktreeRoot, { recursive: true })
    // A git-ignored dir that the worktree does NOT have yet — the thing sharedPaths links back.
    fs.mkdirSync(path.join(repoRoot, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(repoRoot, 'node_modules', 'marker.txt'), 'x')
  })
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  const depsFor = (over: Partial<WorktreeSharedPathsDeps> = {}): WorktreeSharedPathsDeps => ({
    readSettings: async () => snapshotWithSharedPaths(['node_modules']),
    targetInfo: () => ({ cwd: repoRoot, name: 'demo' }),
    worktreeList: async (): Promise<WorktreeListResult> => ({
      ok: true,
      entries: [
        { path: repoRoot, branch: 'main', head: null, isBare: false },
        { path: worktreeRoot, branch: 'feature', head: null, isBare: false }
      ]
    }),
    ...over
  })

  it('materializes the sharedPaths list it reads by projectId — the renderer never passes one', async () => {
    const f = fakePlatform()
    // The wire passes ONLY (projectId, worktreePath); the list comes from readSettings.
    registerWorktreeSharedPathsHandlers(f, depsFor())
    const res = await materialize(f, 'p1', worktreeRoot)
    expect(res).toEqual([{ path: 'node_modules', status: 'linked' }])
    // The symlink actually points back at the repo copy.
    const linked = path.join(worktreeRoot, 'node_modules', 'marker.txt')
    expect(fs.readFileSync(linked, 'utf-8')).toBe('x')
  })

  it('refuses a worktreePath that is not one of the project’s worktrees → []', async () => {
    const f = fakePlatform()
    registerWorktreeSharedPathsHandlers(f, depsFor())
    const strayer = path.join(os.tmpdir(), 'nt-not-a-worktree')
    fs.mkdirSync(strayer, { recursive: true })
    const res = await materialize(f, 'p1', strayer)
    expect(res).toEqual([])
    // And nothing was linked into the stray dir.
    expect(fs.existsSync(path.join(strayer, 'node_modules'))).toBe(false)
    fs.rmSync(strayer, { recursive: true, force: true })
  })

  it('an SSH project → [] (materialization is local-only this PR)', async () => {
    const f = fakePlatform()
    registerWorktreeSharedPathsHandlers(
      f,
      depsFor({
        targetInfo: () => ({
          ssh: { host: 'h', user: 'u', remoteCwd: '/srv/app' } as never,
          name: 'demo'
        })
      })
    )
    const res = await materialize(f, 'p1', worktreeRoot)
    expect(res).toEqual([])
  })

  it('an unknown project (no target info) → []', async () => {
    const f = fakePlatform()
    registerWorktreeSharedPathsHandlers(f, depsFor({ targetInfo: () => null }))
    const res = await materialize(f, 'p1', worktreeRoot)
    expect(res).toEqual([])
  })

  it('a non-string projectId or worktreePath → []', async () => {
    const f = fakePlatform()
    registerWorktreeSharedPathsHandlers(f, depsFor())
    expect(await materialize(f, 42, worktreeRoot)).toEqual([])
    expect(await materialize(f, 'p1', undefined)).toEqual([])
  })

  it('no sharedPaths configured → [] (nothing to link)', async () => {
    const f = fakePlatform()
    registerWorktreeSharedPathsHandlers(
      f,
      depsFor({ readSettings: async () => snapshotWithSharedPaths([]) })
    )
    const res = await materialize(f, 'p1', worktreeRoot)
    expect(res).toEqual([])
  })
})
