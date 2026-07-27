import { describe, it, expect } from 'vitest'
import {
  scopeFromKey,
  scopeUsage,
  usageScopeFor,
  usageScopeKey,
  type UsageScope
} from './usageScope'
import type {
  ClaudeAccount,
  ClaudeUsage,
  Project,
  ProviderUsage,
  RemoteAccountUsage,
  UsageLimit
} from '@shared/types'

function limit(over: Partial<UsageLimit> = {}): UsageLimit {
  return {
    kind: 'session',
    group: 'session',
    usedPercent: 10,
    severity: null,
    resetsAt: null,
    windowMinutes: null,
    scopeLabel: null,
    isActive: false,
    ...over
  }
}

function usage(limits: UsageLimit[], status: ClaudeUsage['status'] = 'ok'): ClaudeUsage {
  return { limits, session: null, weekly: null, email: null, updatedAt: 0, status }
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'p',
    color: '#fff',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    ...over
  }
}

const sshProject = (user: string, host: string): Project =>
  project({
    ssh: { server: { host, user, port: 22 } as never, remoteCwd: '/srv' }
  })

const remoteRow = (
  hostKey: string,
  accountId: string | null,
  limits: UsageLimit[],
  status: ClaudeUsage['status'] = 'ok'
): RemoteAccountUsage => ({
  hostKey,
  accountId,
  label: accountId ?? hostKey,
  usage: usage(limits, status)
})

const LOCAL: UsageScope = { kind: 'local' }
const ACCOUNTS: ClaudeAccount[] = [{ id: 'a1', label: 'Work', createdAt: 0 }]
const PROVIDERS: ProviderUsage[] = [
  { provider: 'codex', limits: [limit()], account: null, updatedAt: 0, status: 'ok' }
]

describe('usageScopeFor', () => {
  it('is local for a folder project, a missing one, and a relay tab', () => {
    expect(usageScopeFor(project())).toEqual(LOCAL)
    expect(usageScopeFor(undefined)).toEqual(LOCAL)
    // A relay tab's terminals run on a peer's desktop, but `usage` is app-global and stays local —
    // showing someone else's quota under your own pill would be a lie about their account.
    expect(usageScopeFor(project({ remote: true }))).toEqual(LOCAL)
  })

  it('is the host for an SSH project', () => {
    expect(usageScopeFor(sshProject('root', 'niova.example.com'))).toEqual({
      kind: 'ssh',
      hostKey: 'root@niova.example.com'
    })
  })
})

describe('usageScopeKey / scopeFromKey', () => {
  it('round-trips the scope through the one primitive a store selector can compare', () => {
    expect(usageScopeKey(project())).toBe('')
    expect(scopeFromKey('')).toEqual(LOCAL)
    const key = usageScopeKey(sshProject('root', 'alpha'))
    expect(key).toBe('root@alpha')
    expect(scopeFromKey(key)).toEqual({ kind: 'ssh', hostKey: 'root@alpha' })
  })
})

describe('scopeUsage — local project', () => {
  it('keeps this machine’s accounts and providers, and drops every host', () => {
    const out = scopeUsage({
      scope: LOCAL,
      claude: usage([limit({ usedPercent: 13 })]),
      accounts: ACCOUNTS,
      providers: PROVIDERS,
      remote: [remoteRow('root@alpha', null, [limit({ usedPercent: 90 })])]
    })
    expect(out.claude?.limits[0].usedPercent).toBe(13)
    expect(out.accounts).toHaveLength(1)
    expect(out.providers).toHaveLength(1)
    expect(out.remote).toEqual([])
    // A busy server must not drive the pill of a project that does not run there.
    expect(out.pillLimits.map((l) => l.usedPercent)).toEqual([13])
  })
})

describe('scopeUsage — SSH project', () => {
  const scope: UsageScope = { kind: 'ssh', hostKey: 'root@alpha' }

  it('shows only that host — no local Claude, no local providers', () => {
    const out = scopeUsage({
      scope,
      claude: usage([limit({ usedPercent: 13 })]),
      accounts: ACCOUNTS,
      providers: PROVIDERS,
      remote: [
        remoteRow('root@alpha', null, [limit({ usedPercent: 23 })]),
        remoteRow('root@beta', null, [limit({ usedPercent: 99 })])
      ]
    })
    expect(out.claude).toBeNull()
    expect(out.accounts).toEqual([])
    expect(out.providers).toEqual([])
    expect(out.remote.map((r) => r.hostKey)).toEqual(['root@alpha'])
    expect(out.pillLimits.map((l) => l.usedPercent)).toEqual([23])
  })

  it('leads the pill with the host’s SYSTEM account, not a managed one', () => {
    const out = scopeUsage({
      scope,
      claude: null,
      accounts: [],
      providers: [],
      remote: [
        remoteRow('root@alpha', 'a1', [limit({ usedPercent: 88 })]),
        remoteRow('root@alpha', null, [limit({ usedPercent: 23 })])
      ]
    })
    expect(out.pillLimits.map((l) => l.usedPercent)).toEqual([23])
    expect(out.remote).toHaveLength(2) // both still listed in the popover
  })

  it('falls back to a managed account when the system one has nothing', () => {
    // A host used only through a managed login would otherwise show an empty pill over a full
    // popover.
    const out = scopeUsage({
      scope,
      claude: null,
      accounts: [],
      providers: [],
      remote: [
        remoteRow('root@alpha', null, [], 'unavailable'),
        remoteRow('root@alpha', 'a1', [limit({ usedPercent: 88 })])
      ]
    })
    expect(out.pillLimits.map((l) => l.usedPercent)).toEqual([88])
  })

  it('has nothing to say before the host has answered', () => {
    const out = scopeUsage({ scope, claude: usage([limit()]), accounts: ACCOUNTS, providers: PROVIDERS, remote: [] })
    expect(out.pillLimits).toEqual([])
    expect(out.remote).toEqual([])
  })
})
