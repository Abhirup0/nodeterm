import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  isValidPendingId,
  pendingDir,
  writePendingAnswerLocal,
  sweepPendingDir,
  PENDING_MAX_AGE_MS
} from './pending-approvals'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-pending-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('isValidPendingId', () => {
  it('accepts the script charset', () => {
    expect(isValidPendingId('nt_node-1720000000000-12345')).toBe(true)
    expect(isValidPendingId('abcXYZ_09-')).toBe(true)
  })
  it('rejects traversal / injection / empty', () => {
    expect(isValidPendingId('')).toBe(false)
    expect(isValidPendingId('../etc/passwd')).toBe(false)
    expect(isValidPendingId('a/b')).toBe(false)
    expect(isValidPendingId('a b')).toBe(false)
    expect(isValidPendingId('a;rm -rf')).toBe(false)
    expect(isValidPendingId('a.answer')).toBe(false)
    expect(isValidPendingId('a'.repeat(257))).toBe(false)
  })
})

describe('writePendingAnswerLocal', () => {
  it('writes the one-line answer file for a valid id + decision', async () => {
    const ok = await writePendingAnswerLocal('node-1-2', 'allow', home)
    expect(ok).toBe(true)
    const file = path.join(pendingDir(home), 'node-1-2.answer')
    expect(fs.readFileSync(file, 'utf8')).toBe('allow')
  })

  it('writes deny too', async () => {
    expect(await writePendingAnswerLocal('n', 'deny', home)).toBe(true)
    expect(fs.readFileSync(path.join(pendingDir(home), 'n.answer'), 'utf8')).toBe('deny')
  })

  it('leaves no .tmp behind (atomic rename)', async () => {
    await writePendingAnswerLocal('n', 'allow', home)
    const entries = fs.readdirSync(pendingDir(home))
    expect(entries).toEqual(['n.answer'])
  })

  it('refuses an invalid pendingId and writes nothing', async () => {
    expect(await writePendingAnswerLocal('../evil', 'allow', home)).toBe(false)
    expect(fs.existsSync(pendingDir(home))).toBe(false)
  })

  it('refuses an out-of-contract decision', async () => {
    // @ts-expect-error — exercising the runtime guard against a bad value
    expect(await writePendingAnswerLocal('n', 'always', home)).toBe(false)
  })
})

describe('sweepPendingDir', () => {
  it('removes files older than the max age, keeps fresh ones', async () => {
    const dir = pendingDir(home)
    fs.mkdirSync(dir, { recursive: true })
    const stale = path.join(dir, 'old-1.json')
    const fresh = path.join(dir, 'new-1.json')
    fs.writeFileSync(stale, '{}')
    fs.writeFileSync(fresh, '{}')
    const now = Date.now()
    // Backdate the stale file well past the window.
    const old = new Date(now - PENDING_MAX_AGE_MS - 60_000)
    fs.utimesSync(stale, old, old)

    const removed = await sweepPendingDir(now, PENDING_MAX_AGE_MS, home)
    expect(removed).toBe(1)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('also sweeps stale .answer orphans and ignores unrelated files', async () => {
    const dir = pendingDir(home)
    fs.mkdirSync(dir, { recursive: true })
    const ans = path.join(dir, 'x.answer')
    const other = path.join(dir, 'notes.txt')
    fs.writeFileSync(ans, 'allow')
    fs.writeFileSync(other, 'keep')
    const now = Date.now()
    const old = new Date(now - PENDING_MAX_AGE_MS - 1000)
    fs.utimesSync(ans, old, old)
    fs.utimesSync(other, old, old)

    const removed = await sweepPendingDir(now, PENDING_MAX_AGE_MS, home)
    expect(removed).toBe(1)
    expect(fs.existsSync(ans)).toBe(false)
    expect(fs.existsSync(other)).toBe(true) // non-pending file untouched
  })

  it('returns 0 (no throw) when the dir does not exist', async () => {
    expect(await sweepPendingDir(Date.now(), PENDING_MAX_AGE_MS, home)).toBe(0)
  })
})
