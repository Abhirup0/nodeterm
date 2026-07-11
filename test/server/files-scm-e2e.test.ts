import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import WebSocket from 'ws'
import { startServer } from '../../src/server/index'
import { SESSION_COOKIE } from '../../src/server/http'
import { IPC } from '../../src/shared/ipc'

describe('files/scm e2e: fs.read + git over ws', () => {
  let dataDir: string, repo: string, close: () => Promise<void>, port: number, cookie: string

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-e2e-scm-'))
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-e2e-repo-'))
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo })
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
    fs.writeFileSync(path.join(repo, 'r.txt'), 'hello\n')
    git('add', '.'); git('commit', '-qm', 'init')

    const srv = await startServer({
      port: 0, host: '127.0.0.1', dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'), insecureHttp: false,
      passwordSeed: 'scm-e2e-pw',
      // Never touch the developer's real ~/.claude — the hook would point into `dataDir`,
      // which afterAll removes, leaving a dangling hook that breaks every agent session.
      installHooks: false
    })
    port = srv.port; close = srv.close
    const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=scm-e2e-pw',
      redirect: 'manual'
    })
    cookie = res.headers.get('set-cookie')!.split(';')[0]
  }, 30_000)

  afterAll(async () => {
    await close?.()
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it('reads a file and gets git status over ws', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } })
    await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })
    function rpc(id: number, method: string, args: unknown[]): Promise<unknown> {
      return new Promise((resolve) => {
        const onMsg = (d: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary) return
          const m = JSON.parse(d.toString())
          if (m.t === 'res' && m.id === id) { ws.off('message', onMsg); resolve(m) }
        }
        ws.on('message', onMsg)
        ws.send(JSON.stringify({ t: 'req', id, method, args }))
      })
    }
    const read = (await rpc(1, IPC.fsRead, [path.join(repo, 'r.txt')])) as { ok: boolean; result: string }
    expect(read.ok).toBe(true)
    expect(read.result).toBe('hello\n')
    const status = (await rpc(2, IPC.gitStatus, [repo])) as { ok: boolean }
    expect(status.ok).toBe(true)
    ws.close()
  }, 30_000)
})
