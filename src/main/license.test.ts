import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { IPC } from '../shared/ipc'
import type { LicenseStatus } from '../shared/types'

// One temp userData dir per run; hoisted so the electron mock factory can see it.
const h = vi.hoisted(() => ({ userData: '', publicKeyPem: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userData, isPackaged: false },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() }
}))

vi.mock('./entitlement-key', () => ({
  get ENTITLEMENT_PUBLIC_KEY() {
    return h.publicKeyPem
  }
}))

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
h.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

/** Mint a token the same way the server does: base64url(payload).base64url(sig). */
function mint(ttlSeconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({
      deviceId: 'test-device',
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

function fakeWindow(): { win: never; sent: LicenseStatus[] } {
  const sent: LicenseStatus[] = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, status: LicenseStatus) => {
        if (channel === IPC.licenseChanged) sent.push(status)
      }
    }
  }
  return { win: win as never, sent }
}

const HOUR = 60 * 60 * 1000

/** Let real I/O (fs writes in save()) and microtasks settle — setTimeout stays unfaked. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 25))
}

describe('license entitlement refresh', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Only the refresh interval and the clock are faked: fetch/fs promises and the
    // 8s abort timers stay on the real event loop so awaits actually settle.
    vi.useFakeTimers({ toFake: ['setInterval', 'Date'] })
    h.userData = mkdtempSync(path.join(tmpdir(), 'nt-license-test-'))
    delete process.env.DO_NOT_TRACK
    delete process.env.NODETERM_TELEMETRY_DISABLED
    process.env.NODETERM_API_BASE = 'http://127.0.0.1:1'
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    rmSync(h.userData, { recursive: true, force: true })
  })

  it('launch refresh (device-bound) stores the minted token and broadcasts Pro', async () => {
    const token = mint(7 * 24 * 60 * 60)
    fetchMock.mockResolvedValue(jsonResponse({ active: true, token }))
    const { initLicense } = await import('./license')
    const { win, sent } = fakeWindow()
    initLicense(win)
    await flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sent.length).toBe(1)
    expect(sent[0].active).toBe(true)
    expect(sent[0].tier).toBe('pro')
  })

  it('keeps refreshing periodically so a mid-session token expiry re-mints instead of dropping Pro', async () => {
    // Server hands out short-lived tokens (7d in prod); simulate one that expires
    // within the session, then a re-mint on the next poll.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })
    )
    const { initLicense } = await import('./license')
    const { win, sent } = fakeWindow()
    initLicense(win)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A day passes in-session: the app must have polled again on its own —
    // launch-only refresh means the token silently expires after 7 days.
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    await flush()
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    const last = sent[sent.length - 1]
    expect(last.active).toBe(true)
  })

  it('a periodic refresh that finds the device revoked drops Pro mid-session', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ active: true, token: mint(7 * 24 * 60 * 60) })
    )
    const { initLicense } = await import('./license')
    const { win, sent } = fakeWindow()
    initLicense(win)
    await flush()
    expect(sent[sent.length - 1].active).toBe(true)

    // From now on the server says: not entitled (canceled subscription).
    fetchMock.mockResolvedValue(jsonResponse({ active: false }))
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    await flush()
    expect(sent[sent.length - 1].active).toBe(false)
  })
})
