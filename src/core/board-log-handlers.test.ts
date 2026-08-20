import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { registerBoardLogHandlers, type BoardLogRoute, type BoardLogRouter } from './board-log-handlers'
import { boardLogRemotePath, type RemoteLogExec } from './board-log'
import { IPC } from '../shared/ipc'
import type { BoardLogEntry, BoardLogReadResult } from '../shared/types'

const entry = (over: Partial<BoardLogEntry> = {}): BoardLogEntry => ({
  id: 'e1',
  ts: 1000,
  author: { name: 'enes', color: '#f00' },
  kind: 'comment',
  text: 'hello',
  ...over
})

// A router that always returns a fixed route — most tests need only one project.
const routerFor = (route: BoardLogRoute): BoardLogRouter => ({ route: () => route })

const append = (f: FakePlatform, projectId: string, e: BoardLogEntry) =>
  f.handlers[IPC.boardLogAppend](projectId, e) as Promise<boolean>
const read = (f: FakePlatform, projectId: string, opts?: unknown) =>
  f.handlers[IPC.boardLogRead](projectId, opts) as Promise<BoardLogReadResult>

describe('registerBoardLogHandlers — routing', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-boardlog-h-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('local: append writes and read returns the entry newest-first', async () => {
    const f = fakePlatform()
    registerBoardLogHandlers(f, routerFor({ kind: 'local', cwd: dir }))
    expect(await append(f, 'p1', entry({ id: 'a' }))).toBe(true)
    expect(await append(f, 'p1', entry({ id: 'b' }))).toBe(true)
    const res = await read(f, 'p1')
    expect(res.unsupported).toBeUndefined()
    expect(res.entries.map((e) => e.id)).toEqual(['b', 'a'])
    // file is on disk under .nodeterm
    expect(fs.existsSync(path.join(dir, '.nodeterm', 'board-log.jsonl'))).toBe(true)
  })

  it('unsupported: append resolves false, read returns { entries: [], unsupported: true }', async () => {
    const f = fakePlatform()
    registerBoardLogHandlers(f, routerFor({ kind: 'unsupported' }))
    expect(await append(f, 'p1', entry())).toBe(false)
    expect(await read(f, 'p1')).toEqual({ entries: [], unsupported: true })
  })

  it('returns an in-process append that writes THROUGH the same router (no IPC round-trip) — Task 9.2', async () => {
    const f = fakePlatform()
    const handlers = registerBoardLogHandlers(f, routerFor({ kind: 'local', cwd: dir }))
    // The main-side caller (the cookie trace) appends without going through the renderer.
    expect(await handlers.append('p1', entry({ id: 'trace', kind: 'event', text: undefined }))).toBe(true)
    const res = await read(f, 'p1')
    expect(res.entries.map((e) => e.id)).toContain('trace')
  })

  it('the in-process append reports false on an unsupported project (fail-closed feeds the cookie gate)', async () => {
    const f = fakePlatform()
    const handlers = registerBoardLogHandlers(f, routerFor({ kind: 'unsupported' }))
    expect(await handlers.append('p1', entry())).toBe(false)
  })

  it('remote: routes through the injected exec (append + tail)', async () => {
    const store: string[] = []
    const exec: RemoteLogExec = {
      append: async (_p, line) => void store.push(line),
      tail: async () => store.join('\n')
    }
    const f = fakePlatform()
    registerBoardLogHandlers(f, routerFor({ kind: 'remote', remoteCwd: '/remote/cwd', exec, fingerprint: async () => '0' }))
    expect(await append(f, 'p1', entry({ id: 'x' }))).toBe(true)
    const res = await read(f, 'p1')
    expect(res.entries.map((e) => e.id)).toEqual(['x'])
  })

  it('append never throws when the remote exec rejects → resolves false', async () => {
    const exec: RemoteLogExec = {
      append: async () => {
        throw new Error('ssh down')
      },
      tail: async () => ''
    }
    const f = fakePlatform()
    registerBoardLogHandlers(f, routerFor({ kind: 'remote', remoteCwd: '/r', exec, fingerprint: async () => '0' }))
    await expect(append(f, 'p1', entry())).resolves.toBe(false)
  })
})

describe('registerBoardLogHandlers — change subscription', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-boardlog-h-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('local watch: broadcasts boardLogChanged on the project channel after an append', async () => {
    const f = fakePlatform()
    registerBoardLogHandlers(f, routerFor({ kind: 'local', cwd: dir }))
    // A real project's .nodeterm dir exists (project.json lives there); the store watches that dir,
    // so create it before subscribing (an initial append does that).
    await append(f, 'p1', entry({ id: 'a' }))
    f.listeners[IPC.boardLogSubscribe]('p1')
    await append(f, 'p1', entry({ id: 'b' }))
    // fs.watch is debounced 250ms in the store; give it margin
    await new Promise((r) => setTimeout(r, 500))
    const pushed = f.sent.filter((s) => s.channel === IPC.boardLogChanged('p1'))
    expect(pushed.length).toBeGreaterThanOrEqual(1)
    f.listeners[IPC.boardLogUnsubscribe]('p1')
  })

  it('remote poll: broadcasts only when the fingerprint changes; stops on last unsubscribe', async () => {
    vi.useFakeTimers()
    try {
      let fp = 'a'
      const calls = { fingerprint: 0 }
      const exec: RemoteLogExec = { append: async () => {}, tail: async () => '' }
      const f = fakePlatform()
      registerBoardLogHandlers(
        f,
        routerFor({
          kind: 'remote',
          remoteCwd: '/r',
          exec,
          fingerprint: async () => {
            calls.fingerprint++
            return fp
          }
        })
      )
      // two subscribers, ref-counted
      f.listeners[IPC.boardLogSubscribe]('p1')
      f.listeners[IPC.boardLogSubscribe]('p1')
      await vi.advanceTimersByTimeAsync(0) // initial tick sets last = 'a' (no push)
      expect(f.sent.filter((s) => s.channel === IPC.boardLogChanged('p1'))).toHaveLength(0)

      fp = 'b'
      await vi.advanceTimersByTimeAsync(5000)
      expect(f.sent.filter((s) => s.channel === IPC.boardLogChanged('p1'))).toHaveLength(1)

      // one unsubscribe keeps the poll alive (count still 1)
      f.listeners[IPC.boardLogUnsubscribe]('p1')
      const before = calls.fingerprint
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls.fingerprint).toBeGreaterThan(before)

      // last unsubscribe stops the poll: no further fingerprint calls
      f.listeners[IPC.boardLogUnsubscribe]('p1')
      const settled = calls.fingerprint
      await vi.advanceTimersByTimeAsync(15000)
      expect(calls.fingerprint).toBe(settled)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('boardLogRemotePath', () => {
  it('joins cwd/.nodeterm/board-log.jsonl posix-style', () => {
    expect(boardLogRemotePath('/home/u/proj')).toBe('/home/u/proj/.nodeterm/board-log.jsonl')
    expect(boardLogRemotePath('~/proj/')).toBe('~/proj/.nodeterm/board-log.jsonl')
  })
})
