// What the RPC surface DECIDES: which machine a query is answered from. The sweeps themselves are
// covered by session-memory.test.ts / session-memory-remote.test.ts — here the only question is
// routing, and the only dangerous answer is attributing one host's memory to another.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IPC } from '../shared/ipc'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { startSessionMemoryService, sshScopePredicate } from './session-memory-service'
import type { MemInfo, SessionMemoryReport, SessionMemoryQuery } from '../shared/types'

// The repo's own platform fake (src/core/platform-fake.ts) — a plain recording object whose
// `handlers` map holds whatever the service registered. Same setup as usage-service.remote.test.ts.
let platform: FakePlatform

const read = (q: SessionMemoryQuery): Promise<SessionMemoryReport> =>
  platform.handlers[IPC.sessionMemory](q) as Promise<SessionMemoryReport>
const host = (q: SessionMemoryQuery): Promise<MemInfo | null> =>
  platform.handlers[IPC.sessionMemoryHost](q) as Promise<MemInfo | null>

/** A remote reply the parser accepts: all three markers, in order, with one process row. */
const OK_REPLY = '##MEM\n##PANES\n##PROCS\n100 1 1024\n'

beforeEach(() => {
  resetPlatformForTests()
  platform = fakePlatform()
  initPlatform(platform)
})

afterEach(() => resetPlatformForTests())

describe('startSessionMemoryService', () => {
  it('routes a LOCAL project to the local sweep', async () => {
    const run = vi.fn()
    startSessionMemoryService({
      // The local sweep short-circuits to ok:false with no tmux binary, which is enough to prove
      // routing without touching the host's real tmux.
      tmuxBin: () => null,
      remote: { run, isRemoteProject: () => false }
    })
    const r = await read({ projectId: 'p1' })
    expect(run).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
  })

  it('routes an SSH project to the remote runner', async () => {
    const run = vi.fn(async () => OK_REPLY)
    startSessionMemoryService({
      tmuxBin: () => '/usr/bin/tmux',
      remote: { run, isRemoteProject: (id) => id === 'ssh1' }
    })
    const r = await read({ projectId: 'ssh1' })
    expect(run).toHaveBeenCalledOnce()
    expect(r.ok).toBe(true)
  })

  it('answers ok:false for an SSH project when no remote deps were injected', async () => {
    // The Server Edition case: no ControlMaster to run on. It must not silently answer with the
    // LOCAL machine's sessions, which belong to a different host entirely.
    //
    // `readMem` is the mutation detector: a local sweep always reads it, a refusal never does. The
    // ok/rows assertions alone would survive the guard's deletion on a host whose tmux happens to
    // be missing (every socket errors ⇒ ok:false either way) — a green test proving nothing.
    const readMem = vi.fn(() => ({ availableMb: 11, totalMb: 22 }))
    startSessionMemoryService({ tmuxBin: () => '/usr/bin/tmux', readMem })
    const r = await read({ projectId: 'ssh1', remote: true })
    expect(r.ok).toBe(false)
    expect(r.rows).toEqual([])
    expect(r.mem).toBeNull()
    expect(readMem).not.toHaveBeenCalled()
  })

  it('refuses a remote:true query the shell does not recognise as remote', async () => {
    // The two sources disagree — the renderer says SSH, the manager has no such project (not yet
    // connected, or already gone). Trusting the manager here would sweep THIS machine and label
    // the rows as the host's. The claim of remoteness is what decides; only its ANSWER is doubted.
    // `run` returns a VALID reply, so `ok:false` can no longer be true by accident: it would be
    // `true` if the read were routed remotely and `true` (locally swept) if it were not — the only
    // way to get a refusal here is the disagreement being resolved towards the remote host and the
    // runner reporting it could not look. `readMem` catches a local sweep whatever tmux does.
    const readMem = vi.fn(() => ({ availableMb: 11, totalMb: 22 }))
    const run = vi.fn(async () => null)
    startSessionMemoryService({
      tmuxBin: () => '/usr/bin/tmux',
      readMem,
      remote: { run, isRemoteProject: () => false }
    })
    const r = await read({ projectId: 'ssh1', remote: true })
    expect(run).toHaveBeenCalledOnce()
    expect(r).toEqual({ ok: false, rows: [], mem: null })
    expect(readMem).not.toHaveBeenCalled()
  })

  it('treats a DISCONNECTED ssh project as remote (identity, not liveness)', async () => {
    // The desktop's `isRemoteProject`. `connectedHosts()` answers "is the master up right now",
    // which is false for a project that is reconnecting, just dropped, or not opened yet — and a
    // "no" there used to mean the LOCAL sweep answered under the remote host's name. The workspace
    // index is the connection-independent source, so an SSH project counts while offline.
    const isRemoteProject = sshScopePredicate({
      sshProjectIds: () => ['ssh1'],
      connectedProjectIds: () => [] // nothing connected: every master is down
    })
    expect(isRemoteProject('ssh1')).toBe(true)
    expect(isRemoteProject('local1')).toBe(false)

    // And end-to-end through the service, with the renderer's flag ABSENT — the shell's answer is
    // the only thing standing between this query and a local sweep (the renderer flag is Task 5/7).
    const readMem = vi.fn(() => ({ availableMb: 11, totalMb: 22 }))
    const run = vi.fn(async () => null)
    startSessionMemoryService({ tmuxBin: () => '/usr/bin/tmux', readMem, remote: { run, isRemoteProject } })
    const r = await read({ projectId: 'ssh1' })
    expect(run).toHaveBeenCalledOnce()
    expect(r).toEqual({ ok: false, rows: [], mem: null })
    expect(readMem).not.toHaveBeenCalled()
  })

  it('counts a connected project the index has not listed', async () => {
    // The other direction: an index that has not loaded (or an entry added by another machine)
    // must not make a project with a LIVE master read as local. Neither source can veto the other.
    const isRemoteProject = sshScopePredicate({
      sshProjectIds: () => [],
      connectedProjectIds: () => ['ssh2']
    })
    expect(isRemoteProject('ssh2')).toBe(true)
  })

  it('coalesces the two channels onto ONE remote round trip', async () => {
    // A remote read is a whole-process-table `ps` on somebody else's machine, and the panel wants
    // both the rows and the RAM number. Firing them concurrently must not cost two ssh execs.
    let release: (() => void) | undefined
    const gate = new Promise<void>((res) => {
      release = res
    })
    const run = vi.fn(async () => {
      await gate
      return OK_REPLY
    })
    startSessionMemoryService({
      tmuxBin: () => '/usr/bin/tmux',
      remote: { run, isRemoteProject: () => true }
    })
    const both = Promise.all([read({ projectId: 'ssh1' }), host({ projectId: 'ssh1' })])
    release?.()
    const [report] = await both
    expect(run).toHaveBeenCalledOnce()
    expect(report.ok).toBe(true)

    // Not a cache: once settled, the next read runs again.
    await read({ projectId: 'ssh1' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('never runs the local sweep for a remote scope with no projectId', async () => {
    // `remote: true` with nothing to run against is still not an invitation to read this machine.
    const readMem = vi.fn(() => ({ availableMb: 1, totalMb: 2 }))
    const run = vi.fn()
    startSessionMemoryService({
      tmuxBin: () => '/usr/bin/tmux',
      readMem,
      remote: { run, isRemoteProject: () => true }
    })
    const r = await read({ remote: true })
    expect(run).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: false, rows: [], mem: null })
    // Not even the local RAM number: it describes the wrong machine.
    expect(readMem).not.toHaveBeenCalled()
  })

  it('reads the local RAM for a local scope and the host RAM for a remote one', async () => {
    const readMem = vi.fn(() => ({ availableMb: 11, totalMb: 22 }))
    const run = vi.fn(async () => ['##MEM', 'MemAvailable: 2097152 kB', 'MemTotal: 4194304 kB', '##PANES', '##PROCS', '100 1 1024'].join('\n'))
    startSessionMemoryService({
      tmuxBin: () => '/usr/bin/tmux',
      readMem,
      remote: { run, isRemoteProject: (id) => id === 'ssh1' }
    })
    expect(await host({ projectId: 'p1' })).toEqual({ availableMb: 11, totalMb: 22 })
    expect(await host({ projectId: 'ssh1' })).toEqual({ availableMb: 2048, totalMb: 4096 })
  })

  it('answers a null host RAM for an SSH scope with no remote deps', async () => {
    const readMem = vi.fn(() => ({ availableMb: 11, totalMb: 22 }))
    startSessionMemoryService({ tmuxBin: () => '/usr/bin/tmux', readMem })
    expect(await host({ projectId: 'ssh1', remote: true })).toBeNull()
    expect(readMem).not.toHaveBeenCalled()
  })

  it('tolerates a query-less call (a bare read is this machine)', async () => {
    startSessionMemoryService({ tmuxBin: () => null })
    const r = await (platform.handlers[IPC.sessionMemory]() as Promise<SessionMemoryReport>)
    expect(r.ok).toBe(false)
  })
})
