import { describe, expect, it, vi } from 'vitest'
import { SshProjectManager } from './ssh-project'
import { controlPathFor } from './control-master'

const conn = { host: 'h', user: 'u' }

function makeMgr() {
  const statuses: string[] = []
  // spawnMaster: returns a fake child that "stays up"; run: resolves stdout for one-shot ssh.
  const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn() }))
  const run = vi.fn(async (_args: string[], _stdin?: string) => ({ code: 0, stdout: 'src/\nbin/\n' }))
  const runScp = vi.fn(async (_args: string[]) => ({ code: 0 }))
  const mgr = new SshProjectManager({
    userDataDir: '/ud',
    spawnMaster,
    run,
    runScp,
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

  it('uploadFile uploads via scp under <remoteHome>/.nodeterm/uploads/<token> and returns the abs path', async () => {
    const scpCalls: string[][] = []
    const run = vi.fn(async (args: string[]) =>
      args.join(' ').includes('printf %s') ? { code: 0, stdout: '/home/u' } : { code: 0, stdout: '' }
    )
    const runScp = vi.fn(async (args: string[]) => {
      scpCalls.push(args)
      return { code: 0 }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp,
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn()
    })
    await mgr.connect('p1', conn, '/srv/repo')
    const out = await mgr.uploadFile('p1', '/local/img.png', 'img.png')
    expect(out).toMatch(/^\/home\/u\/\.nodeterm\/uploads\/[a-z0-9]+\/img\.png$/)
    // scp targeted that exact absolute remote path (conn is { host: 'h', user: 'u' }).
    expect(scpCalls[0].join(' ')).toContain(`u@h:${out}`)
  })

  it('uploadFile basenames a traversal fileName so it cannot escape the token dir', async () => {
    const scpCalls: string[][] = []
    const run = vi.fn(async (args: string[]) =>
      args.join(' ').includes('printf %s') ? { code: 0, stdout: '/home/u' } : { code: 0, stdout: '' }
    )
    const runScp = vi.fn(async (args: string[]) => {
      scpCalls.push(args)
      return { code: 0 }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp,
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn()
    })
    await mgr.connect('p1', conn, '/srv/repo')
    // basename('../../evil') === 'evil' → sanitized to <dir>/evil; never escapes the token dir.
    const out = await mgr.uploadFile('p1', '/local/evil', '../../evil')
    expect(out).toMatch(/^\/home\/u\/\.nodeterm\/uploads\/[a-z0-9]+\/evil$/)
    expect(out).not.toContain('..')
    expect(scpCalls[0].join(' ')).toContain(`u@h:${out}`)
  })

  it('connect writes + source-files the remote tmux.conf and returns its absolute path', async () => {
    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push({ args, stdin })
      return args.join(' ').includes('printf %s')
        ? { code: 0, stdout: '/home/u' }
        : { code: 0, stdout: '' }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn()
    })
    const { tmuxConfPath } = await mgr.connect('p1', conn)
    expect(tmuxConfPath).toBe('/home/u/.nodeterm/tmux.conf')
    // The conf was written via `cat >` (with the conf body as stdin) and then source-file'd.
    const write = calls.find((c) => c.args.join(' ').includes(`cat > '/home/u/.nodeterm/tmux.conf'`))
    expect(write).toBeDefined()
    expect(write?.stdin).toContain('set -g mouse on')
    expect(calls.some((c) => c.args.join(' ').includes(`source-file '/home/u/.nodeterm/tmux.conf'`))).toBe(true)
  })

  it('connect leaves tmuxConfPath undefined when the remote conf write fails (no -f to a missing conf)', async () => {
    // The runner resolves (does not throw) on a non-zero remote exit. Fail the `cat >`/mkdir write
    // with code 1 while letting the $HOME probe succeed so remoteHome resolves — this isolates the
    // write-failure path. tmuxConfPath must stay undefined (so no `-f <missing-conf>`), yet connect
    // still succeeds and returns the control path.
    const run = vi.fn(async (args: string[]) => {
      const cmd = args.join(' ')
      if (cmd.includes('printf %s')) return { code: 0, stdout: '/home/u' }
      if (cmd.includes('cat > ') || cmd.includes('mkdir -p')) return { code: 1, stdout: '' }
      return { code: 0, stdout: '' }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: vi.fn()
    })
    const { controlPath, tmuxConfPath } = await mgr.connect('p1', conn)
    expect(tmuxConfPath).toBeUndefined()
    expect(controlPath).toBe(controlPathFor('p1'))
  })

  it('uploadFile fails open (null) when not connected', async () => {
    const { mgr } = makeMgr()
    expect(await mgr.uploadFile('nope', '/x', 'x')).toBeNull()
  })

  it('uploadFile rejects a non-absolute localPath (argv flag-smuggling guard)', async () => {
    const scpCalls: string[][] = []
    const run = vi.fn(async (args: string[]) =>
      args.join(' ').includes('printf %s') ? { code: 0, stdout: '/home/u' } : { code: 0, stdout: '' }
    )
    const runScp = vi.fn(async (args: string[]) => { scpCalls.push(args); return { code: 0 } })
    const mgr = new SshProjectManager({
      userDataDir: '/ud', spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run, runScp, getHook: () => ({ port: 1, token: 't', version: '1' }), onStatus: vi.fn()
    })
    await mgr.connect('p1', conn, '/srv/repo')
    // A leading `-` would be parsed by scp as an OPTION (e.g. -oProxyCommand=…) → reject; also relative.
    expect(await mgr.uploadFile('p1', '-oProxyCommand=touch /tmp/pwned', 'x.png')).toBeNull()
    expect(await mgr.uploadFile('p1', 'relative/path.png', 'x.png')).toBeNull()
    expect(scpCalls).toHaveLength(0) // scp never invoked for an unsafe localPath
  })
})
