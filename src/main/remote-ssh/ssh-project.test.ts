import { promises as fs } from 'fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshProjectManager, lastSshErrorLine } from './ssh-project'
import { controlPathFor } from '../../core/remote-ssh/control-master'

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
    // (A later `connected` event can carry the async claude-CLI probe's answer — see below.)
    expect(statuses.slice(0, 2)).toEqual(['connecting', 'connected'])
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

  // --- remote `claude --version` probe ------------------------------------------------------
  //
  // The probe runs through a LOGIN shell, so the user's profile can print banners to stdout. The
  // value is marker-delimited and only what sits between the markers is parsed — a banner version
  // (`Ubuntu 22.04.3`) must NEVER be read as claude's version, or every Claude node in the project
  // would launch `--permission-mode auto` on a CLI that exits 1 on it.
  const BANNER = 'Welcome — Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-89-generic)\nkernel 6.8.0-106\n'

  /** A manager whose remote claude probe answers with `banner + <markers>version</markers>`.
   *  Pass an array to script successive probe attempts (retry coverage); the last entry repeats. */
  function mgrWithClaude(versionOut: string | null | (string | null)[], retryDelaysMs?: number[]) {
    const outputs = Array.isArray(versionOut) ? versionOut : [versionOut]
    let probeCalls = 0
    const events: {
      status: string
      claudeAutoPermissionMode?: boolean
      remoteClaudeVersion?: string | null
    }[] = []
    const run = vi.fn(async (args: string[]) => {
      const cmd = args.join(' ')
      if (cmd.includes('__NT_V_START__')) {
        const out = outputs[Math.min(probeCalls++, outputs.length - 1)]
        return { code: 0, stdout: out === null ? BANNER : `${BANNER}${out}` }
      }
      if (cmd.includes('printf %s')) return { code: 0, stdout: '/home/u' }
      return { code: 0, stdout: '' }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: (e) =>
        events.push({
          status: e.status,
          claudeAutoPermissionMode: e.claudeAutoPermissionMode,
          remoteClaudeVersion: e.remoteClaudeVersion
        }),
      ...(retryDelaysMs ? { probeRetryDelaysMs: retryDelaysMs } : {})
    })
    return { mgr, events, run, probeCallCount: () => probeCalls }
  }

  const probeEvent = (
    events: { claudeAutoPermissionMode?: boolean; remoteClaudeVersion?: string | null }[]
  ) => events.find((e) => e.claudeAutoPermissionMode !== undefined)

  const probeEvents = (
    events: { claudeAutoPermissionMode?: boolean; remoteClaudeVersion?: string | null }[]
  ) => events.filter((e) => e.claudeAutoPermissionMode !== undefined)

  it('a login-shell BANNER around an OLD claude never reports auto support (merge blocker)', async () => {
    const { mgr, events } = mgrWithClaude('__NT_V_START__2.0.30 (Claude Code)__NT_V_END__')
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvent(events)).toBeDefined())
    // The banner's `22.04.3` is NOT the version: the CLI is 2.0.30 → no `--permission-mode auto`.
    expect(probeEvent(events)?.claudeAutoPermissionMode).toBe(false)
  })

  it('a banner with no claude output at all is a FAILED probe, not a modern CLI', async () => {
    const { mgr, events } = mgrWithClaude(null) // markers absent → unknown
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvent(events)).toBeDefined())
    expect(probeEvent(events)?.claudeAutoPermissionMode).toBe(false)
  })

  it('a modern claude behind a banner does report auto support', async () => {
    const { mgr, events } = mgrWithClaude('__NT_V_START__2.1.90 (Claude Code)__NT_V_END__')
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvent(events)).toBeDefined())
    expect(probeEvent(events)?.claudeAutoPermissionMode).toBe(true)
  })

  it('the status event carries the probed remote version (for the tab-menu hint)', async () => {
    const { mgr, events } = mgrWithClaude('__NT_V_START__2.0.30 (Claude Code)__NT_V_END__')
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvent(events)).toBeDefined())
    expect(probeEvent(events)?.remoteClaudeVersion).toBe('2.0.30 (Claude Code)')
  })

  it('a FAILED probe reports version null (distinguishable from "old CLI") and retries', async () => {
    // First attempt: markers absent (claude not found — e.g. a transient PATH/login-shell hiccup);
    // second attempt: a modern CLI. The first answer must land immediately (fail-open `false`,
    // version null) so launch paths never wait on retries, and the retry must upgrade it to `true`.
    const { mgr, events } = mgrWithClaude(
      [null, '__NT_V_START__2.1.90 (Claude Code)__NT_V_END__'],
      [1]
    )
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvents(events).length).toBeGreaterThanOrEqual(2))
    const probes = probeEvents(events)
    expect(probes[0]).toMatchObject({ claudeAutoPermissionMode: false, remoteClaudeVersion: null })
    expect(probes[probes.length - 1]).toMatchObject({
      claudeAutoPermissionMode: true,
      remoteClaudeVersion: '2.1.90 (Claude Code)'
    })
  })

  it('a definite version answer stops the retries (a CLI does not upgrade mid-connection)', async () => {
    const { mgr, events, probeCallCount } = mgrWithClaude(
      '__NT_V_START__2.0.30 (Claude Code)__NT_V_END__',
      [1, 1, 1]
    )
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvent(events)).toBeDefined())
    // Give any (wrong) retry loop time to fire before counting.
    await new Promise((r) => setTimeout(r, 30))
    expect(probeCallCount()).toBe(1)
  })

  it('gives up retrying after the configured attempts when claude never appears', async () => {
    const { mgr, events, probeCallCount } = mgrWithClaude(null, [1, 1])
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvents(events).length).toBeGreaterThanOrEqual(3))
    await new Promise((r) => setTimeout(r, 30))
    expect(probeCallCount()).toBe(3) // initial attempt + 2 retries, then stop
    expect(probeEvents(events).every((e) => e.claudeAutoPermissionMode === false)).toBe(true)
  })

  it('a reused connection returns the probed answer + version with the connect result', async () => {
    const { mgr, events } = mgrWithClaude('__NT_V_START__2.1.90 (Claude Code)__NT_V_END__')
    await mgr.connect('p1', conn)
    await vi.waitFor(() => expect(probeEvent(events)).toBeDefined())
    const res = await mgr.connect('p1', conn)
    expect(res.claudeAutoPermissionMode).toBe(true)
    expect(res.remoteClaudeVersion).toBe('2.1.90 (Claude Code)')
  })

  it('connect does NOT wait on the claude probe (it runs after `connected`)', async () => {
    // The probe's `$SHELL -lc` sources nvm/conda inits and can take seconds; every remote terminal
    // in the project waits on connect, so the probe must be off that path.
    const events: string[] = []
    let releaseProbe: (() => void) | undefined
    const run = vi.fn(async (args: string[]) => {
      const cmd = args.join(' ')
      if (cmd.includes('__NT_V_START__')) {
        await new Promise<void>((r) => (releaseProbe = r)) // never resolves during this test
        return { code: 0, stdout: '' }
      }
      return { code: 0, stdout: '' }
    })
    const mgr = new SshProjectManager({
      userDataDir: '/ud',
      spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
      run,
      runScp: vi.fn(async () => ({ code: 0 })),
      getHook: () => ({ port: 1, token: 't', version: '1' }),
      onStatus: (e) => events.push(e.status)
    })
    const res = await mgr.connect('p1', conn) // resolves while the probe is still hanging
    expect(events).toEqual(['connecting', 'connected'])
    expect(res.claudeAutoPermissionMode).toBeUndefined() // unknown ⇒ bare command (fail-open)
    releaseProbe?.()
  })

  it('remoteAccountAdd reads the version from the markers, not from banner noise', async () => {
    // Same probe, other consumer: an OLD remote CLI must still report versionSupported=false so the
    // keychain-collision warning survives (the banner's `22.04.3` would have suppressed it).
    const { mgr } = mgrWithClaude('__NT_V_START__2.0.14 (Claude Code)__NT_V_END__')
    await mgr.connect('p1', conn)
    expect((await mgr.remoteAccountAdd('p1', 'acc1'))?.versionSupported).toBe(false)

    const modern = mgrWithClaude('__NT_V_START__2.1.0 (Claude Code)__NT_V_END__')
    await modern.mgr.connect('p2', conn)
    expect((await modern.mgr.remoteAccountAdd('p2', 'acc1'))?.versionSupported).toBe(true)

    // Probe failed entirely (no markers) → fail-open true: adding an account is never blocked.
    const unknown = mgrWithClaude(null)
    await unknown.mgr.connect('p3', conn)
    expect((await unknown.mgr.remoteAccountAdd('p3', 'acc1'))?.versionSupported).toBe(true)
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

  // --- leftover ControlMaster socket handling -----------------------------------------------
  //
  // A master socket FILE can outlive its process (app crash, `kill -9`, host sleep). ssh's
  // ControlMaster=auto refuses to bind over an existing socket file, so a stale one makes every
  // `-O check` fail and connect() time out with a generic error — the field-reported "SSH
  // connection error" with no cause. A fresh connect must clear a dead leftover before spawning.
  describe('leftover master socket', () => {
    const isCheck = (args: string[]) => args[0] === '-O' && args[1] === 'check'

    afterEach(() => vi.restoreAllMocks())

    it('unlinks a DEAD leftover socket before spawning a fresh master', async () => {
      const statuses: string[] = []
      let masterUp = false
      const spawnMaster = vi.fn(() => {
        masterUp = true
        return { kill: vi.fn(), on: vi.fn() }
      })
      // The leftover master is dead → `-O check` fails until we spawn our own.
      const run = vi.fn(async (args: string[]) =>
        isCheck(args) ? { code: masterUp ? 0 : 1, stdout: '' } : { code: 0, stdout: '' }
      )
      vi.spyOn(fs, 'stat').mockResolvedValue({ isSocket: () => true } as never)
      const rmSpy = vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: (e) => statuses.push(e.status)
      })
      const { controlPath } = await mgr.connect('p1', conn)
      expect(rmSpy).toHaveBeenCalledWith(controlPathFor('p1'), { force: true })
      expect(spawnMaster).toHaveBeenCalledTimes(1)
      expect(controlPath).toBe(controlPathFor('p1'))
      expect(statuses.slice(0, 2)).toEqual(['connecting', 'connected'])
    })

    it('adopts a LIVE orphan master instead of spawning a second one', async () => {
      const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn() }))
      const run = vi.fn(async (_args: string[]) => ({ code: 0, stdout: '' })) // live master answers
      vi.spyOn(fs, 'stat').mockResolvedValue({ isSocket: () => true } as never)
      const rmSpy = vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
      const statuses: string[] = []
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: (e) => statuses.push(e.status)
      })
      await mgr.connect('p1', conn)
      expect(spawnMaster).not.toHaveBeenCalled() // reused, not respawned
      expect(rmSpy).not.toHaveBeenCalled() // a live socket is never unlinked
      expect(statuses.slice(0, 2)).toEqual(['connecting', 'connected'])
    })

    it('skips the probe entirely when no socket file exists (the normal path)', async () => {
      const spawnMaster = vi.fn(() => ({ kill: vi.fn(), on: vi.fn() }))
      const checks: string[][] = []
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === '-O' && args[1] === 'check') checks.push(args)
        return { code: 0, stdout: '' }
      })
      vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      const rmSpy = vi.spyOn(fs, 'rm').mockResolvedValue(undefined)
      const mgr = new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster,
        run,
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 1, token: 't', version: '1' }),
        onStatus: vi.fn()
      })
      await mgr.connect('p1', conn)
      expect(spawnMaster).toHaveBeenCalledTimes(1)
      expect(rmSpy).not.toHaveBeenCalled() // nothing to clean
      // Only the connect loop's `-O check` runs — no extra leftover-probe round-trip.
      expect(checks.length).toBeGreaterThanOrEqual(1)
    })
  })
})

describe('lastSshErrorLine', () => {
  it('picks the actionable last line, skipping debug noise', () => {
    const stderr = [
      'debug1: Connecting to 95.217.38.239 port 22.',
      'debug1: Authenticating to 95.217.38.239 as root',
      'root@95.217.38.239: Permission denied (publickey).'
    ].join('\n')
    expect(lastSshErrorLine(stderr)).toBe('root@95.217.38.239: Permission denied (publickey).')
  })

  it('skips a trailing Warning line to keep the real cause', () => {
    const stderr = 'ssh: Could not resolve hostname niova: nodename nor servname provided\nWarning: something'
    expect(lastSshErrorLine(stderr)).toBe(
      'ssh: Could not resolve hostname niova: nodename nor servname provided'
    )
  })

  it('returns undefined for empty / whitespace-only stderr', () => {
    expect(lastSshErrorLine('   \n\n  ')).toBeUndefined()
    expect(lastSshErrorLine('')).toBeUndefined()
  })

  it('truncates a runaway line so the banner can not blow up', () => {
    const long = 'x'.repeat(500)
    const out = lastSshErrorLine(long)!
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(201)
  })
})
