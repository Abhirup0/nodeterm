/**
 * Issue #385 — `readProjectFile` collapses "gone", "unreadable" and "corrupt" into one `null`,
 * which is right for its callers but wrong for recovery: clearing a project's placeholder lets the
 * next save write its empty canvas, so acting on a failed read would overwrite the only copy.
 * `projectFileState` is the honest question, and only a definite ENOENT counts as absence.
 *
 * MUTATION: make the catch return 'absent' unconditionally (i.e. treat any error as absence) →
 * the ENOTDIR case below reddens, which is the case that stands in for a permissions/mount error.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'

describe('projectFileState distinguishes absence from a failed read', () => {
  let dir: string
  let store: WorkspaceStore

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-pfs-'))
    initPlatform(fakePlatform({ userDataDir: dir }))
    store = new WorkspaceStore()
  })
  afterEach(() => {
    resetPlatformForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports absent for a folder with no .nodeterm/project.json', async () => {
    const folder = path.join(dir, 'plain')
    mkdirSync(folder)
    expect(await store.projectFileState(folder)).toBe('absent')
  })

  it('reports present once the file exists', async () => {
    const folder = path.join(dir, 'withfile')
    mkdirSync(path.join(folder, '.nodeterm'), { recursive: true })
    writeFileSync(path.join(folder, '.nodeterm', 'project.json'), '{"version":1,"nodes":[]}')
    expect(await store.projectFileState(folder)).toBe('present')
  })

  it('reports present for a CORRUPT file — a parse failure is not an absence', async () => {
    const folder = path.join(dir, 'corrupt')
    mkdirSync(path.join(folder, '.nodeterm'), { recursive: true })
    writeFileSync(path.join(folder, '.nodeterm', 'project.json'), 'not json at all')
    expect(await store.projectFileState(folder)).toBe('present')
  })

  it('reports unreadable, NOT absent, when the read fails for any other reason', async () => {
    // `.nodeterm` is a FILE here, so stat'ing project.json under it fails ENOTDIR — a stand-in for
    // the permissions / stalled-mount errors that must never be read as "the file is gone".
    const folder = path.join(dir, 'blocked')
    mkdirSync(folder)
    writeFileSync(path.join(folder, '.nodeterm'), 'i am not a directory')
    expect(await store.projectFileState(folder)).toBe('unreadable')
  })
})
