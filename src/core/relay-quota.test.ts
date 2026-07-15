import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const h = vi.hoisted(() => ({ premium: false }))
vi.mock('./license', () => ({ isPremium: () => h.premium }))

let userData = ''

async function boot() {
  vi.resetModules()
  const { initPlatform } = await import('./platform')
  const { fakePlatform } = await import('./platform-fake')
  const fake = fakePlatform({ userDataDir: userData, isPackaged: false })
  initPlatform(fake)
  const quota = await import('./relay-quota')
  return { fake, quota }
}

describe('relay-quota', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-15T12:00:00'))
    h.premium = false
    userData = mkdtempSync(path.join(tmpdir(), 'nt-relay-quota-'))
  })
  afterEach(async () => {
    const { resetPlatformForTests } = await import('./platform')
    resetPlatformForTests()
    vi.useRealTimers()
    rmSync(userData, { recursive: true, force: true })
  })

  it('counts a fresh (peer, day) and stays silent-compatible on the first use', async () => {
    const { quota } = await boot()
    expect(quota.consumeRelayUse('phoneA')).toEqual({ kind: 'ok', used: 1, limit: 5 })
  })

  it('same peer same local day never double-counts', async () => {
    const { quota } = await boot()
    quota.consumeRelayUse('phoneA')
    expect(quota.consumeRelayUse('phoneA')).toEqual({ kind: 'already', used: 1, limit: 5 })
  })

  it('same peer on a NEW day consumes a new slot', async () => {
    const { quota } = await boot()
    quota.consumeRelayUse('phoneA')
    vi.setSystemTime(new Date('2026-07-16T12:00:00'))
    expect(quota.consumeRelayUse('phoneA')).toEqual({ kind: 'ok', used: 2, limit: 5 })
  })

  it('exhausts at the limit and refuses a 6th distinct pair', async () => {
    const { quota } = await boot()
    for (const p of ['a', 'b', 'c', 'd', 'e']) quota.consumeRelayUse(p)
    expect(quota.consumeRelayUse('f')).toEqual({ kind: 'exhausted', used: 5, limit: 5 })
    // …but a peer already counted today still gets in:
    expect(quota.consumeRelayUse('a')).toEqual({ kind: 'already', used: 5, limit: 5 })
  })

  it('month rollover resets the ledger', async () => {
    const { quota } = await boot()
    for (const p of ['a', 'b', 'c', 'd', 'e']) quota.consumeRelayUse(p)
    vi.setSystemTime(new Date('2026-08-01T09:00:00'))
    expect(quota.consumeRelayUse('f')).toEqual({ kind: 'ok', used: 1, limit: 5 })
  })

  it('clock rollback cannot mint a fresh month (lastSeen anchor)', async () => {
    const { quota } = await boot()
    for (const p of ['a', 'b', 'c', 'd', 'e']) quota.consumeRelayUse(p)
    vi.setSystemTime(new Date('2026-06-01T09:00:00')) // roll BACK before the ledger month
    expect(quota.consumeRelayUse('f').kind).toBe('exhausted')
  })

  it('premium bypasses without writing the ledger', async () => {
    h.premium = true
    const { quota } = await boot()
    expect(quota.consumeRelayUse('phoneA')).toEqual({ kind: 'unlimited' })
    expect(quota.relayQuotaStatus().unlimited).toBe(true)
  })

  it('relayQuotaAvailable: true under limit, true when only a today-peer could enter, false when cold-exhausted', async () => {
    const { quota } = await boot()
    expect(quota.relayQuotaAvailable()).toBe(true)
    for (const p of ['a', 'b', 'c', 'd', 'e']) quota.consumeRelayUse(p)
    expect(quota.relayQuotaAvailable()).toBe(true) // entries today → an already-counted peer may return
    vi.setSystemTime(new Date('2026-07-20T12:00:00')) // same month, later day: no entry is "today"
    expect(quota.relayQuotaAvailable()).toBe(false)
  })

  it('status handler + change broadcast go over CorePlatform', async () => {
    const { fake, quota } = await boot()
    quota.initRelayQuota()
    quota.consumeRelayUse('phoneA')
    await vi.waitFor(() => {
      expect(fake.sent.some((s) => s.channel === 'relay-quota:changed')).toBe(true)
    })
  })

  it('a corrupt store file degrades to an empty ledger', async () => {
    const { quota } = await boot()
    writeFileSync(path.join(userData, 'relay-quota.json'), '{not json')
    expect(quota.consumeRelayUse('a')).toEqual({ kind: 'ok', used: 1, limit: 5 })
  })
})
