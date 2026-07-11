import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { WorkspaceWatcher } from './workspace-watcher'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

let dir: string
let file: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-watch-'))
  file = path.join(dir, 'project.json')
  await fs.writeFile(file, '{"v":1}')
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('WorkspaceWatcher', () => {
  it('fires for an outside edit, but not for a self-write', async () => {
    const events: string[] = []
    let self = ''
    const w = new WorkspaceWatcher({
      paths: () => [file],
      isSelfWrite: (_p, content) => content === self,
      onExternalChange: (p) => events.push(p),
      debounceMs: 30
    })
    w.sync()
    self = '{"v":2}'
    await fs.writeFile(file, self)          // simulated own save
    await wait(120)
    expect(events).toEqual([])
    await fs.writeFile(file, '{"v":3}')     // outside edit (git pull)
    await wait(120)
    expect(events).toEqual([file])
    w.dispose()
  })

  it('drops watchers for paths that disappear from paths()', async () => {
    const events: string[] = []
    let paths = [file]
    const w = new WorkspaceWatcher({
      paths: () => paths,
      isSelfWrite: () => false,
      onExternalChange: (p) => events.push(p),
      debounceMs: 30
    })
    w.sync()
    paths = []
    w.sync()
    await fs.writeFile(file, '{"v":9}')
    await wait(120)
    expect(events).toEqual([])
    w.dispose()
  })
})
