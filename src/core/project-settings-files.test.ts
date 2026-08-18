import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { readProjectSettingsFile, writeProjectSettingsFile, projectSettingsPath } from './project-settings-files'

let root: string
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-psf-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('project settings file IO', () => {
  it('reports absent when the file (or .nodeterm) does not exist', async () => {
    expect((await readProjectSettingsFile(root)).status).toBe('absent')
  })
  it('write → read round-trips and bumps rev only on content change', async () => {
    const v1 = await writeProjectSettingsFile(root, { terminal: { shell: '/bin/zsh' } }, null, 't1')
    expect(v1.rev).toBe(1)
    const same = await writeProjectSettingsFile(root, { terminal: { shell: '/bin/zsh' } }, v1, 't2')
    expect(same.rev).toBe(1) // unchanged content: no rewrite
    const v2 = await writeProjectSettingsFile(root, { terminal: { shell: '/bin/bash' } }, v1, 't3')
    expect(v2.rev).toBe(2)
    const read = await readProjectSettingsFile(root)
    expect(read.status).toBe('ok')
    if (read.status === 'ok') expect(read.file.terminal?.shell).toBe('/bin/bash')
  })
  it('sidelines an unparsable file to .corrupt-<ts> and reports invalid', async () => {
    await fs.mkdir(path.join(root, '.nodeterm'), { recursive: true })
    await fs.writeFile(projectSettingsPath(root), '{broken', 'utf-8')
    expect((await readProjectSettingsFile(root)).status).toBe('invalid')
    const names = await fs.readdir(path.join(root, '.nodeterm'))
    expect(names.some((n) => n.startsWith('settings.json.corrupt-'))).toBe(true)
    expect(names.includes('settings.json')).toBe(false)
  })
  it('leaves a git-conflict-marked file in place and reports conflict', async () => {
    await fs.mkdir(path.join(root, '.nodeterm'), { recursive: true })
    const raw = '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> theirs\n'
    await fs.writeFile(projectSettingsPath(root), raw, 'utf-8')
    expect((await readProjectSettingsFile(root)).status).toBe('conflict')
    expect(await fs.readFile(projectSettingsPath(root), 'utf-8')).toBe(raw)
  })
  it('bumps rev over prev even when the caller passes back the previously-read file as doc', async () => {
    const v1 = await writeProjectSettingsFile(root, { terminal: { shell: '/bin/zsh' } }, null, 't1')
    const read = await readProjectSettingsFile(root)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    // A caller may pass the READ FILE straight back as `doc` (it structurally satisfies
    // ProjectSettingsDoc) — its stale version/rev/savedAt must not survive into the write.
    const edited = { ...read.file, terminal: { shell: '/bin/fish' } }
    const v2 = await writeProjectSettingsFile(root, edited, v1, 't2')
    expect(v2.rev).toBe(v1.rev + 1)
    expect(v2.savedAt).toBe('t2')
    expect(v2.terminal?.shell).toBe('/bin/fish')
  })
})
