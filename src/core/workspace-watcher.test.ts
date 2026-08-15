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

  // The two below use a REAL atomic replace (`mv -f tmp project.json`), not writeFile: writeFile
  // truncates in place and keeps the inode, so it fires forever on its own and proves nothing.
  // A file-bound fs.watch follows the inode, so only the rebind keeps these alive.
  const replace = async (content: string): Promise<void> => {
    const tmp = path.join(dir, `t-${Math.random().toString(36).slice(2)}`)
    await fs.writeFile(tmp, content)
    await fs.rename(tmp, file)
  }

  it('keeps firing across repeated atomic replacements (the inode changes every time)', async () => {
    const events: string[] = []
    const w = new WorkspaceWatcher({
      paths: () => [file],
      isSelfWrite: () => false,
      onExternalChange: (p) => events.push(p),
      debounceMs: 30
    })
    w.sync()
    for (let i = 0; i < 3; i++) {
      await replace(`{"v":${i}}`)
      await wait(150)
    }
    expect(events).toEqual([file, file, file])
    w.dispose()
  })

  it('survives an unreadable moment: the corrupt-file sideline must not leave the path deaf', async () => {
    const events: string[] = []
    const w = new WorkspaceWatcher({
      paths: () => [file],
      isSelfWrite: () => false,
      onExternalChange: (p) => events.push(p),
      debounceMs: 30
    })
    w.sync()
    // What the store does with a project.json it cannot parse: rename it out of the way. The
    // watcher wakes, finds nothing to read, and must still re-arm on the NAME.
    await fs.rename(file, `${file}.corrupt-1`)
    await wait(150)
    expect(events).toEqual([])
    // A fresh file lands at the same path (the store rewrites it, or a `git checkout` restores it).
    await replace('{"v":"fresh"}')
    await wait(300)
    // …and an outside edit after that is still seen. Before the fix this was silence for the rest
    // of the run: the dead watcher stayed in the map, so sync() skipped the path forever.
    events.length = 0
    await replace('{"v":"outside"}')
    await wait(200)
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
