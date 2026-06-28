import { describe, expect, it, vi } from 'vitest'
import { SshProjectManager } from './ssh-project'

const conn = { host: 'h', user: 'u' }

function makeMgr() {
  const statuses: string[] = []
  // spawnMaster: returns a fake child that "stays up"; run: resolves stdout for one-shot ssh.
  const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn() }))
  const run = vi.fn(async (_args: string[]) => ({ code: 0, stdout: 'src/\nbin/\n' }))
  const mgr = new SshProjectManager({
    userDataDir: '/ud',
    spawnMaster,
    run,
    onStatus: (e) => statuses.push(e.status)
  })
  return { mgr, statuses, spawnMaster, run }
}

describe('SshProjectManager', () => {
  it('connect emits connecting→connected and returns the control path', async () => {
    const { mgr, statuses } = makeMgr()
    const { controlPath } = await mgr.connect('p1', conn)
    expect(controlPath).toBe('/ud/ssh-cm/p1.sock')
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
})
