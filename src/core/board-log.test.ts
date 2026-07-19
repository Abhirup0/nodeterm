import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { BoardLogEntry } from '@shared/types'
import { buildLine, parseLines, validEntry, BoardLogStore, type RemoteLogExec } from './board-log'

const entry = (over: Partial<BoardLogEntry> = {}): BoardLogEntry => ({
  id: 'e1',
  ts: 1000,
  author: { name: 'enes', color: '#f00' },
  kind: 'comment',
  text: 'hello',
  ...over
})

describe('buildLine / parseLines / validEntry', () => {
  it('buildLine is single-line JSON + newline, round-trips through parseLines', () => {
    const e = entry({ text: 'line one\nline two' }) // newline in text is JSON-escaped, stays one line
    const line = buildLine(e)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1).includes('\n')).toBe(false)
    expect(parseLines(line)).toEqual([e])
  })

  it('parseLines is tolerant: skips a garbage line, keeps the valid one', () => {
    const good = buildLine(entry({ id: 'ok' }))
    const raw = 'not json\n' + '{"missing":"fields"}\n' + good
    expect(parseLines(raw)).toEqual([entry({ id: 'ok' })])
  })

  it('parseLines is newest-first and capped at 500 by default; all:true returns everything', () => {
    const raw = Array.from({ length: 600 }, (_, i) => buildLine(entry({ id: `e${i}`, ts: i }))).join('')
    const capped = parseLines(raw)
    expect(capped).toHaveLength(500)
    expect(capped[0].id).toBe('e599') // newest first
    expect(capped[499].id).toBe('e100')
    expect(parseLines(raw, { all: true })).toHaveLength(600)
    expect(parseLines(raw, { cap: 3 }).map((e) => e.id)).toEqual(['e599', 'e598', 'e597'])
  })

  it('validEntry accepts a comment and an event entry, rejects malformed shapes', () => {
    expect(validEntry(entry())).toBe(true)
    expect(validEntry(entry({ kind: 'event', text: undefined, event: { type: 'card-moved', from: 'a', to: 'b' } }))).toBe(true)
    expect(validEntry(null)).toBe(false)
    expect(validEntry({ id: 1, ts: 0, author: { name: 'x', color: 'y' }, kind: 'comment' })).toBe(false)
    expect(validEntry({ id: 'x', ts: 'no', author: { name: 'x', color: 'y' }, kind: 'comment' })).toBe(false)
    expect(validEntry({ id: 'x', ts: 0, author: { name: 'x' }, kind: 'comment' })).toBe(false)
    expect(validEntry({ id: 'x', ts: 0, author: { name: 'x', color: 'y' }, kind: 'nope' })).toBe(false)
  })
})

describe('BoardLogStore (local fs)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-log-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('append writes to <cwd>/.nodeterm/board-log.jsonl and read returns newest-first', async () => {
    const store = new BoardLogStore({})
    expect(await store.append(dir, entry({ id: 'a', ts: 1 }))).toBe(true)
    expect(await store.append(dir, entry({ id: 'b', ts: 2 }))).toBe(true)
    expect(fs.existsSync(path.join(dir, '.nodeterm', 'board-log.jsonl'))).toBe(true)
    const got = await store.read(dir)
    expect(got.map((e) => e.id)).toEqual(['b', 'a'])
  })

  it('read returns [] when the log file does not exist', async () => {
    expect(await new BoardLogStore({}).read(dir)).toEqual([])
  })

  it('append never throws and returns false when the path is unwritable', async () => {
    // A regular file where the cwd should be → mkdir(<file>/.nodeterm) fails with ENOTDIR.
    const file = path.join(dir, 'not-a-dir')
    fs.writeFileSync(file, 'x')
    await expect(new BoardLogStore({}).append(file, entry())).resolves.toBe(false)
  })

  it('watch fires (debounced) when the log changes, and the returned unsub stops it', async () => {
    const store = new BoardLogStore({})
    await store.append(dir, entry({ id: 'seed' }))
    let hits = 0
    const unsub = store.watch(dir, () => {
      hits++
    })
    await store.append(dir, entry({ id: 'later' }))
    await new Promise((r) => setTimeout(r, 500))
    unsub()
    expect(hits).toBeGreaterThanOrEqual(1)
    const after = hits
    await store.append(dir, entry({ id: 'after-unsub' }))
    await new Promise((r) => setTimeout(r, 400))
    expect(hits).toBe(after)
  })
})

describe('BoardLogStore (remote exec injected)', () => {
  it('append passes the newline-free JSON line to remote.append; read tails and parses', async () => {
    const appended: Array<{ path: string; line: string }> = []
    let tailReq: { path: string; lines: number } | undefined
    const raw = buildLine(entry({ id: 'r1', ts: 1 })) + buildLine(entry({ id: 'r2', ts: 2 }))
    const remote: RemoteLogExec = {
      append: async (p, line) => {
        appended.push({ path: p, line })
      },
      tail: async (p, lines) => {
        tailReq = { path: p, lines }
        return raw
      }
    }
    const store = new BoardLogStore({ remote })
    expect(await store.append('/srv/proj', entry({ id: 'r2', ts: 2 }))).toBe(true)
    expect(appended[0].path).toBe('/srv/proj/.nodeterm/board-log.jsonl')
    expect(appended[0].line.includes('\n')).toBe(false) // printf adds the newline remote-side
    const got = await store.read('/srv/proj', { cap: 10 })
    expect(tailReq).toEqual({ path: '/srv/proj/.nodeterm/board-log.jsonl', lines: 10 })
    expect(got.map((e) => e.id)).toEqual(['r2', 'r1'])
  })

  it('remote append returns false when the exec rejects; watch is a no-op unsub', async () => {
    const remote: RemoteLogExec = {
      append: async () => {
        throw new Error('ssh down')
      },
      tail: async () => ''
    }
    const store = new BoardLogStore({ remote })
    expect(await store.append('/srv/proj', entry())).toBe(false)
    expect(typeof store.watch('/srv/proj', () => {})).toBe('function')
  })
})
