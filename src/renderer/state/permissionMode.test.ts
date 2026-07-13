import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULT_SETTINGS, UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps } from '@shared/types'
import type { SshConnection } from '@shared/ssh'
import { useProjects } from './projects'
import { useSettings } from './settings'
import { useSshConn } from './sshConn'
import {
  activePermissionMode,
  ensureActivePermissionMode,
  ensureClaudeCliCaps,
  resetClaudeCliCapsForTests
} from './permissionMode'

/** Stand in for the preload/bridge `claude.cliCaps()` probe. */
function mockCliCaps(caps: ClaudeCliCaps | Error): ReturnType<typeof vi.fn> {
  const fn = vi.fn(() => (caps instanceof Error ? Promise.reject(caps) : Promise.resolve(caps)))
  ;(globalThis as { window?: unknown }).window = { nodeTerminal: { claude: { cliCaps: fn } } }
  return fn
}

const MODERN: ClaudeCliCaps = { version: '2.1.207 (Claude Code)', autoPermissionMode: true, fullscreenTui: true }
const OLD: ClaudeCliCaps = { version: '2.1.50 (Claude Code)', autoPermissionMode: false, fullscreenTui: false }

const SSH_SERVER = { id: 's1', label: 'box', host: 'box', user: 'me' } as unknown as SshConnection

beforeEach(() => {
  useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: false })
  useSshConn.setState({ byProject: {}, autoPermByProject: {} })
  resetClaudeCliCapsForTests()
  mockCliCaps(MODERN)
})

/** Adds a project and makes it active. */
function activeProject(name = 'p', ssh?: { server: SshConnection; remoteCwd: string }) {
  const p = useProjects.getState().addProject(name, '/tmp/p')
  if (ssh) useProjects.getState().replaceProject({ ...p, ssh })
  useProjects.getState().setActive(p.id)
  return p
}

describe('activePermissionMode', () => {
  it('returns the global setting when the active project has no override', async () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, claudePermissionMode: 'plan' } }))
    activeProject()
    await ensureClaudeCliCaps()

    expect(activePermissionMode()).toBe('plan')
  })

  it("returns the active project's override, not another project's", async () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, claudePermissionMode: 'auto' } }))
    const other = useProjects.getState().addProject('other', '/tmp/other')
    useProjects.getState().setProjectDefaultPermissionMode(other.id, 'bypassPermissions')
    const active = useProjects.getState().addProject('active', '/tmp/active')
    useProjects.getState().setProjectDefaultPermissionMode(active.id, 'acceptEdits')
    useProjects.getState().setActive(active.id)
    await ensureClaudeCliCaps()

    // The bug this test exists to catch: a stray project.find()-style lookup could pick up
    // the wrong project's override (e.g. the first one in the array) instead of the active one.
    expect(activePermissionMode()).toBe('acceptEdits')
    expect(activePermissionMode()).not.toBe('bypassPermissions')
  })

  it('falls back to the global setting when there is no active project', async () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, claudePermissionMode: 'manual' } }))
    useProjects.getState().addProject('solo', '/tmp/solo')
    useProjects.getState().setActive('nonexistent-id')
    await ensureClaudeCliCaps()

    expect(activePermissionMode()).toBe('manual')
  })
})

// The whole point of the version gate: `auto` is our DEFAULT, and a Claude CLI < 2.1.71 exits 1
// on `--permission-mode auto`. Degrading to `manual` (= no flag) keeps every launch working.
describe('activePermissionMode — the `auto` version gate', () => {
  it('keeps auto when the local CLI is new enough', async () => {
    mockCliCaps(MODERN)
    activeProject()
    await ensureClaudeCliCaps()

    expect(activePermissionMode()).toBe('auto')
  })

  it('degrades auto to manual (bare command) when the local CLI is too old', async () => {
    mockCliCaps(OLD)
    activeProject()
    await ensureClaudeCliCaps()

    expect(activePermissionMode()).toBe('manual')
  })

  it('degrades auto to manual before the probe has answered (conservative)', () => {
    mockCliCaps(MODERN)
    activeProject()
    // Deliberately NOT awaiting ensureClaudeCliCaps: an unknown version means no flag.
    expect(activePermissionMode()).toBe('manual')
  })

  it('degrades auto to manual when the probe rejects', async () => {
    mockCliCaps(new Error('spawn ENOENT'))
    activeProject()
    await ensureClaudeCliCaps()

    expect(activePermissionMode()).toBe('manual')
  })

  it('never touches the other four modes, even with an old CLI', async () => {
    mockCliCaps(OLD)
    const p = activeProject()
    await ensureClaudeCliCaps()

    for (const mode of ['manual', 'acceptEdits', 'plan', 'bypassPermissions'] as const) {
      useProjects.getState().setProjectDefaultPermissionMode(p.id, mode)
      expect(activePermissionMode()).toBe(mode)
    }
  })

  it('probes once and caches (the CLI version does not change under a running app)', async () => {
    const fn = mockCliCaps(MODERN)
    activeProject()
    await Promise.all([ensureClaudeCliCaps(), ensureClaudeCliCaps()])
    await ensureClaudeCliCaps()

    expect(fn).toHaveBeenCalledTimes(1)
  })
})

// An SSH project's terminals run on the REMOTE host, whose claude CLI can be older than the local
// one. The local probe's answer must never be applied to a remote launch.
describe('activePermissionMode — SSH projects', () => {
  it('ignores the local CLI and uses the remote probe', async () => {
    mockCliCaps(MODERN) // local supports auto…
    const p = activeProject('remote', { server: SSH_SERVER, remoteCwd: '/srv/app' })
    await ensureClaudeCliCaps()
    // …but the remote does not.
    useSshConn.getState().setConn(p.id, { controlPath: '/tmp/cm', claudeAutoPermissionMode: false })

    expect(activePermissionMode()).toBe('manual')
  })

  it('keeps auto when the REMOTE host is known to support it', async () => {
    mockCliCaps(OLD) // local is old — irrelevant for a remote launch
    const p = activeProject('remote', { server: SSH_SERVER, remoteCwd: '/srv/app' })
    await ensureClaudeCliCaps()
    useSshConn.getState().setConn(p.id, { controlPath: '/tmp/cm', claudeAutoPermissionMode: true })

    expect(activePermissionMode()).toBe('auto')
  })

  it('omits auto while the project is not connected / not yet probed', async () => {
    mockCliCaps(MODERN)
    activeProject('remote', { server: SSH_SERVER, remoteCwd: '/srv/app' })
    await ensureClaudeCliCaps()
    // No sshConn entry at all: unknown remote version ⇒ bare command.
    expect(activePermissionMode()).toBe('manual')
  })

  it('still honors an explicitly chosen non-auto mode on an unprobed remote', async () => {
    mockCliCaps(MODERN)
    const p = activeProject('remote', { server: SSH_SERVER, remoteCwd: '/srv/app' })
    useProjects.getState().setProjectDefaultPermissionMode(p.id, 'plan')
    await ensureClaudeCliCaps()

    expect(activePermissionMode()).toBe('plan')
  })
})

describe('ensureActivePermissionMode', () => {
  it('awaits the probe, so a launch right after boot still gets auto', async () => {
    mockCliCaps(MODERN)
    activeProject()

    // Without the await this would be 'manual' (see the conservative case above).
    await expect(ensureActivePermissionMode()).resolves.toBe('auto')
  })

  it('resolves to the fail-open mode when the probe is unavailable', async () => {
    ;(globalThis as { window?: unknown }).window = {}
    resetClaudeCliCapsForTests()
    activeProject()

    await expect(ensureActivePermissionMode()).resolves.toBe('manual')
    expect(await ensureClaudeCliCaps()).toEqual(UNKNOWN_CLAUDE_CLI_CAPS)
  })

  it('never hangs on a probe that never answers (Server Edition: WS-RPC has no timeout)', async () => {
    // A dropped socket between send and response leaves the RPC promise unsettled forever. The
    // relaunch awaits this, so it must time out into the fail-open bare command instead.
    vi.useFakeTimers()
    try {
      ;(globalThis as { window?: unknown }).window = {
        nodeTerminal: { claude: { cliCaps: () => new Promise<never>(() => {}) } }
      }
      resetClaudeCliCapsForTests()
      activeProject()

      const pending = ensureActivePermissionMode()
      await vi.advanceTimersByTimeAsync(3000)
      await expect(pending).resolves.toBe('manual')
    } finally {
      vi.useRealTimers()
    }
  })
})
