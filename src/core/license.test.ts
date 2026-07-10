import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { IPC } from '../shared/ipc'
import type { LicenseStatus } from '../shared/types'

// One temp userData dir per run; hoisted so the entitlement-key mock factory can see it.
const h = vi.hoisted(() => ({
  userData: '',
  publicKeyPem: ''
}))

vi.mock('./entitlement-key', () => ({
  get ENTITLEMENT_PUBLIC_KEY() {
    return h.publicKeyPem
  }
}))

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
h.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

/** Mint a token the same way the server does: base64url(payload).base64url(sig). */
function mint(ttlSeconds: number, deviceId = 'test-device'): string {
  const payload = Buffer.from(
    JSON.stringify({
      deviceId,
      tier: 'pro',
      licenseId: 'lic_test',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + ttlSeconds
    })
  ).toString('base64url')
  const sig = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64url')
  return `${payload}.${sig}`
}

function jsonResponse(body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: async () => body }
}

const HOUR = 60 * 60 * 1000

/** Let real I/O (fs writes in save()) and microtasks settle — setTimeout stays unfaked. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 25))
}

describe('license entitlement refresh', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let fake: import('./platform-fake').FakePlatform

  // The licenseChanged statuses broadcast so far (fake.sent records {to, channel, args}).
  const sent = (): LicenseStatus[] =>
    fake.sent.filter((s) => s.channel === IPC.licenseChanged).map((s) => s.args[0] as LicenseStatus)

  beforeEach(async () => {
    // Only the refresh interval and the clock are faked: fetch/fs promises and the
    // 8s abort timers stay on the real event loop so awaits actually settle.
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    h.userData = mkdtempSync(path.join(tmpdir(), 'nt-license-test-'))
    // Pin this "machine"'s device id so minted tokens match it (device-bound verification).
    writeFileSync(path.join(h.userData, 'device-id'), 'test-device')
    delete process.env.DO_NOT_TRACK
    delete process.env.NODETERM_TELEMETRY_DISABLED
    process.env.NODETERM_API_BASE = 'http://127.0.0.1:1'
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
    // device-id (imported transitively by license) reads userData through the core platform,
    // so point the fake at this run's temp dir. Init on the post-reset module graph the
    // dynamic `import('./license')` below will resolve against.
    const { initPlatform } = await import('./platform')
    const { fakePlatform } = await import('./platform-fake')
    fake = fakePlatform({ userDataDir: h.userData, isPackaged: false })
    initPlatform(fake)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    const { resetPlatformForTests } = await import('./platform')
    resetPlatformForTests()
    rmSync(h.userData, { recursive: true, force: true })
  })

  it('launch refresh (device-bound) stores the minted token and broadcasts Pro', async () => {
    const token = mint(7 * 24 * 60 * 60)
    fetchMock.mockResolvedValue(jsonResponse({ active: true, token }))
    const { initLicense } = await import('./license')
    initLicense()
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sent().length).toBe(1)
    expect(sent()[0].active).toBe(true)
    expect(sent()[0].tier).toBe('pro')
  })

  it('keeps refreshing periodically so a mid-session token expiry re-mints instead of dropping Pro', async () => {
    // Server hands out short-lived tokens (7d in prod); simulate one that expires
    // within the session, then a re-mint on the next poll.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })
    )
    const { initLicense } = await import('./license')
    initLicense()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A day passes in-session: the app must have polled again on its own —
    // launch-only refresh means the token silently expires after 7 days.
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    await flush()
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    const last = sent().at(-1)!
    expect(last.active).toBe(true)
  })

  it('a periodic refresh that finds the device revoked drops Pro mid-session', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })
    )
    const { initLicense } = await import('./license')
    initLicense()
    await flush()
    expect(sent().at(-1)!.active).toBe(true)

    // From now on the server says: not entitled (canceled subscription).
    fetchMock.mockResolvedValue(jsonResponse({ active: false }))
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    await flush()
    expect(sent().at(-1)!.active).toBe(false)
  })

  it('rejects a token minted for a different device (copied license.json)', async () => {
    // Simulates copying license.json + a foreign token onto this machine.
    fetchMock.mockResolvedValue(
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60, 'other-device') })
    )
    const { initLicense } = await import('./license')
    initLicense()
    await flush()

    expect(sent().length).toBeGreaterThan(0)
    expect(sent().at(-1)!.active).toBe(false)
  })

  it('does not revive an expired token when the system clock is rolled back', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })
    )
    const { initLicense } = await import('./license')
    initLicense()
    await flush()
    expect(sent().at(-1)!.active).toBe(true)

    // Server unreachable from now on (offline grace path), and the token expires in-session.
    fetchMock.mockRejectedValue(new Error('offline'))
    await vi.advanceTimersByTimeAsync(7 * 24 * HOUR + 12 * HOUR)
    await flush()

    // Attacker rolls the clock back before the expiry: exp is "in the future" again,
    // but the app has already observed a later time — the token must stay dead.
    vi.setSystemTime(Date.now() - 9 * 24 * HOUR)
    const status = (await fake.handlers[IPC.licenseStatus]()) as LicenseStatus
    expect(status.active).toBe(false)
  })
})
