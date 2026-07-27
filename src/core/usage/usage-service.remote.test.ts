// The `usage:remote` RPC surface: caching, invalidation and failure containment. The command
// itself is covered in remote-claude-usage.test.ts; this is about what the service does with it,
// because a popover row is only as good as the cache behind it — a stale row from a host that
// disconnected an hour ago is worse than no row at all.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform, type FakePlatform } from '../platform-fake'
import { startUsageService, type RemoteUsageDeps, type UsageService } from './usage-service'
import type { RemoteAccountUsage } from '../../shared/types'
import type { RemoteUsageTarget } from './remote-claude-usage'

const OK_REPLY = [
  '__NTU_BEGIN__',
  '__NTU_EMAIL__me@example.com',
  JSON.stringify({ limits: [{ kind: 'session', group: 'session', percent: 60 }] }),
  '__NTU_HTTP__200',
  '__NTU_END__'
].join('\n')

function target(hostKey: string, accountId: string | null = null): RemoteUsageTarget {
  return {
    key: `${hostKey}#${accountId ?? ''}`,
    hostKey,
    projectId: 'p1',
    accountId,
    label: accountId ?? hostKey
  }
}

let platform: FakePlatform
let service: UsageService | undefined

beforeEach(() => {
  resetPlatformForTests()
  platform = fakePlatform()
  initPlatform(platform)
})

afterEach(() => {
  service?.dispose()
  service = undefined
  resetPlatformForTests()
  vi.useRealTimers()
})

/** Start the service with the poll gate shut, so nothing but the remote path is exercised. */
function start(remote?: RemoteUsageDeps): void {
  service = startUsageService({ shouldPoll: () => false, remote })
}

const callRemote = (query?: { hostKey?: string; force?: boolean }): Promise<RemoteAccountUsage[]> =>
  platform.handlers[IPC.usageRemote](query) as Promise<RemoteAccountUsage[]>

describe('usage:remote', () => {
  it('answers empty — never rejects — on a shell with no SSH deps', async () => {
    start()
    // This is the Server Edition's permanent answer, so the UI needs no capability check.
    await expect(callRemote()).resolves.toEqual([])
  })

  it('reads each target and labels the rows by host', async () => {
    const run = vi.fn(async () => OK_REPLY)
    start({ targets: () => [target('root@alpha'), target('root@alpha', 'acc-1')], run })
    const rows = await callRemote()
    expect(rows.map((r) => r.accountId)).toEqual([null, 'acc-1'])
    expect(rows[0].hostKey).toBe('root@alpha')
    expect(rows[0].usage.limits[0].usedPercent).toBe(60)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('serves a repeat call from cache, and re-reads on force', async () => {
    const run = vi.fn(async () => OK_REPLY)
    start({ targets: () => [target('root@alpha')], run })
    await callRemote()
    await callRemote()
    expect(run).toHaveBeenCalledTimes(1)
    await callRemote({ force: true })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('retires a host that has disconnected instead of serving its last numbers', async () => {
    const run = vi.fn(async () => OK_REPLY)
    let connected = [target('root@alpha')]
    start({ targets: () => connected, run })
    expect(await callRemote()).toHaveLength(1)
    connected = []
    expect(await callRemote()).toEqual([])
    // Reconnecting must produce a FRESH read — the evicted entry cannot come back from the cache.
    connected = [target('root@alpha')]
    await callRemote()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent reads of the same target into one ssh round-trip', async () => {
    let resolveRun: ((v: string) => void) | undefined
    const run = vi.fn(() => new Promise<string>((res) => (resolveRun = res)))
    start({ targets: () => [target('root@alpha')], run })
    const both = Promise.all([callRemote(), callRemote()])
    resolveRun?.(OK_REPLY)
    const [a, b] = await both
    expect(run).toHaveBeenCalledTimes(1)
    expect(a[0].usage.status).toBe('ok')
    expect(b[0].usage.status).toBe('ok')
  })

  it('does not let one unreachable host withhold the others', async () => {
    const run = vi.fn(async (t: RemoteUsageTarget) => {
      if (t.hostKey === 'root@beta') throw new Error('master gone')
      return OK_REPLY
    })
    start({ targets: () => [target('root@alpha'), target('root@beta')], run })
    const rows = await callRemote()
    expect(rows.map((r) => r.usage.status)).toEqual(['ok', 'error'])
  })

  it('reads only the named host — the scoped indicator shows one machine', async () => {
    const run = vi.fn(async () => OK_REPLY)
    start({ targets: () => [target('root@alpha'), target('root@beta')], run })
    const rows = await callRemote({ hostKey: 'root@beta' })
    expect(rows.map((r) => r.hostKey)).toEqual(['root@beta'])
    // The other host is not read at all: an ssh exec per connected project, every time the
    // popover opened, is the cost this scoping exists to avoid.
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps the other host’s cache while you look at this one', async () => {
    const run = vi.fn(async () => OK_REPLY)
    start({ targets: () => [target('root@alpha'), target('root@beta')], run })
    await callRemote({ hostKey: 'root@alpha' })
    await callRemote({ hostKey: 'root@beta' })
    // Switching back must not re-read: eviction is against the FULL target list, not the query.
    await callRemote({ hostKey: 'root@alpha' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('survives a throwing target provider', async () => {
    start({
      targets: () => {
        throw new Error('settings blew up')
      },
      run: async () => OK_REPLY
    })
    await expect(callRemote()).resolves.toEqual([])
  })
})
