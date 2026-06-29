import { describe, expect, it, vi } from 'vitest'
import { tailFromOffsetArgs, tailLastBytesArgs, RemoteFile } from './remote-file'

const conn = { host: 'h', user: 'u' }
const ref = { conn, controlPath: '/s.sock', path: '/home/u/.claude/projects/p/x.jsonl' }

describe('remote-file builders', () => {
  it('tailFromOffsetArgs reads bytes after the offset (1-indexed +N)', () => {
    expect(tailFromOffsetArgs(conn, '/s.sock', '/a b.jsonl', 10).join(' '))
      .toContain(`tail -c +11 '/a b.jsonl'`)
  })
  it('tailLastBytesArgs reads the last N bytes', () => {
    expect(tailLastBytesArgs(conn, '/s.sock', '/a.jsonl', 4096).join(' ')).toContain(`tail -c 4096 '/a.jsonl'`)
  })
})

describe('RemoteFile', () => {
  it('readFrom advances offset by the byte length of the returned text', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: 'hello\n' }))
    const rf = new RemoteFile(run)
    expect(await rf.readFrom(ref, 100)).toEqual({ text: 'hello\n', newOffset: 100 + Buffer.byteLength('hello\n') })
  })
  it('readFrom fails open: non-zero code → empty, offset unchanged', async () => {
    const rf = new RemoteFile(async () => ({ code: 1, stdout: '' }))
    expect(await rf.readFrom(ref, 100)).toEqual({ text: '', newOffset: 100 })
  })
  it('readTail returns stdout (empty on failure)', async () => {
    expect(await new RemoteFile(async () => ({ code: 0, stdout: 'X' })).readTail(ref, 10)).toBe('X')
    expect(await new RemoteFile(async () => ({ code: 1, stdout: '' })).readTail(ref, 10)).toBe('')
  })
})
