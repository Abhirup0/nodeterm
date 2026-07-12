import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ServerPlatform } from '../platform-server'
import { registerFsHandlers } from './fs'
import { IPC } from '../../shared/ipc'

let dir: string, platform: ServerPlatform, ui: number
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-fs-'))
  platform = new ServerPlatform({ userDataDir: dir, appVersion: '0' })
  registerFsHandlers(platform)
  ui = platform.attach({ sendText: () => {}, sendBinary: () => {} })
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

async function call(method: string, ...args: unknown[]) {
  const res = await platform.dispatch(ui, { t: 'req', id: 1, method, args })
  if (!res.ok) throw new Error(res.error.code)
  return res.result
}

describe('server fs handlers', () => {
  it('write then read round-trips through fsOps', async () => {
    const f = path.join(dir, 'hi.txt')
    expect(await call(IPC.fsWrite, f, 'merhaba')).toBe(true)
    expect(await call(IPC.fsRead, f)).toBe('merhaba')
  })
  it('list returns directory entries', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
    fs.mkdirSync(path.join(dir, 'sub'))
    const entries = (await call(IPC.fsList, dir)) as Array<{ name: string; dir: boolean }>
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'sub'])
  })
  it('readBinary returns base64', async () => {
    const f = path.join(dir, 'b.bin')
    fs.writeFileSync(f, Buffer.from([1, 2, 3]))
    expect(await call(IPC.fsReadBinary, f)).toBe(Buffer.from([1, 2, 3]).toString('base64'))
  })
  it('mkdir creates a nested dir and exists reports it', async () => {
    const nested = path.join(dir, 'x/y/z')
    expect(await call(IPC.fsExists, nested)).toBe(false)
    expect(await call(IPC.fsMkdir, nested)).toBe(true)
    expect(await call(IPC.fsExists, nested)).toBe(true)
  })
  it('quickOpen lists files under the root', async () => {
    fs.writeFileSync(path.join(dir, 'q.txt'), 'x')
    const files = (await call(IPC.filesQuickOpen, dir)) as string[]
    expect(files.some((p) => p.endsWith('q.txt'))).toBe(true)
  })
})
