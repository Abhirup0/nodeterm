import { describe, expect, it, vi } from 'vitest'
import { SshProjectManager } from './ssh-project'
import { controlPathFor } from './control-master'

const conn = { host: 'h', user: 'u' }

function makeMgr() {
  const statuses: string[] = []
  // spawnMaster: returns a fake child that "stays up"; run: resolves stdout for one-shot ssh.
  const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn() }))
  const run = vi.fn(async (_args: string[], _stdin?: string) => ({ code: 0, stdout: 'src/\nbin/\n' }))
  const mgr = new SshProjectManager({
    userDataDir: '/ud',
    spawnMaster,
    run,
    getHook: () => ({ port: 51234, token: 'tok', version: '1' }),
    onStatus: (e) => statuses.push(e.status)
  })
  return { mgr, statuses, spawnMaster, run }
}

describe('SshProjectManager', () => {
  it('connect emits connecting→connected and returns the control path', async () => {
    const { mgr, statuses } = makeMgr()
    const { controlPath } = await mgr.connect('p1', conn)
    expect(controlPath).toBe(controlPathFor('p1'))
    expect(statuses).toEqual(['connecting', 'connected'])
  })

  it('connect is idempotent — second call reuses the live master', async () => {
    const { mgr, spawnMaster } = makeMgr()
    await mgr.connect('p1', conn)
    await mgr.connect('p1', conn)
    expect(spawnMaster).toHaveBeenCalledTimes(1)
  })

  it('listDir parses remote dir entries', async () => {
    const { mgr } = makeMgr()
    await mgr.connect('p1', conn)
    const { dirs } = await mgr.listDir('p1', '~')
    expect(dirs).toEqual(['bin', 'src'])
  })

  it('refForProject resolves {conn, controlPath} after connect, undefined otherwise', async () => {
    const { mgr } = makeMgr()
    expect(mgr.refForProject('p1')).toBeUndefined()
    await mgr.connect('p1', conn)
    expect(mgr.refForProject('p1')).toEqual({ conn, controlPath: controlPathFor('p1') })
    expect(mgr.refForProject('nope')).toBeUndefined()
  })

  it('refForRemoteCwd resolves {conn, controlPath} by the connected project remote cwd', async () => {
    const { mgr } = makeMgr()
    await mgr.connect('p1', conn, '/srv/repo')
    expect(mgr.refForRemoteCwd('/srv/repo')).toEqual({ conn, controlPath: controlPathFor('p1') })
    expect(mgr.refForRemoteCwd('/nope')).toBeUndefined()
  })
})
