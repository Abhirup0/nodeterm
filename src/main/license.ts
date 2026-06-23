// License/premium client. Runs in the main process: stores the key + last entitlement token,
// activates/refreshes against our API, and verifies the token OFFLINE with the embedded
// Ed25519 public key. Offline grace: a still-unexpired stored token keeps premium alive when
// a refresh can't reach the server.
import { promises as fs, readFileSync } from 'fs'
import path from 'path'
import crypto from 'node:crypto'
import { app, ipcMain, shell, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { LicenseStatus } from '../shared/types'
import { getDeviceId } from './device-id'
import { ENTITLEMENT_PUBLIC_KEY } from './entitlement-key'

const API_BASE = process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev'

// Stripe Payment Link (live) for the Pro subscription. The app appends ?client_reference_id=<deviceId>
// so the webhook binds the purchase to this device → keyless ("device-bound") activation.
// NODETERM_CHECKOUT_URL overrides it for testing (e.g. the test-mode link).
const CHECKOUT_URL = process.env.NODETERM_CHECKOUT_URL || 'https://buy.stripe.com/9B65kFeraflH9ora4A7EQ00'

// Same gate as telemetry/check: never hit the prod API from a dev/unsigned build unless a
// local server is targeted explicitly, and honor DO_NOT_TRACK / the kill switch.
function allowed(): boolean {
  if (process.env.DO_NOT_TRACK || process.env.NODETERM_TELEMETRY_DISABLED) return false
  if (!app.isPackaged && !process.env.NODETERM_API_BASE) return false
  return true
}

interface Stored {
  key?: string
  token?: string
}

function file(): string {
  return path.join(app.getPath('userData'), 'license.json')
}
function load(): Stored {
  try {
    return JSON.parse(readFileSync(file(), 'utf-8')) as Stored
  } catch {
    return {}
  }
}
async function save(s: Stored): Promise<void> {
  await fs.writeFile(file(), JSON.stringify(s), 'utf-8').catch(() => {})
}

interface Payload {
  deviceId: string
  tier: string
  licenseId: string
  exp: number
}

// Offline verification of our compact Ed25519 token: base64url(payload).base64url(sig).
function verify(token: string | undefined): Payload | null {
  if (!token || !ENTITLEMENT_PUBLIC_KEY) return null
  const dot = token.indexOf('.')
  if (dot < 1) return null
  const p = token.slice(0, dot)
  const s = token.slice(dot + 1)
  try {
    const key = crypto.createPublicKey(ENTITLEMENT_PUBLIC_KEY)
    if (!crypto.verify(null, Buffer.from(p), key, Buffer.from(s, 'base64url'))) return null
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf-8')) as Payload
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null
    return payload
  } catch {
    return null
  }
}

function statusFrom(token: string | undefined, error: string | null = null): LicenseStatus {
  const p = verify(token)
  return p
    ? { tier: p.tier, active: true, expiresAt: p.exp, error: null }
    : { tier: null, active: false, expiresAt: null, error }
}

async function call(path: string, body: unknown): Promise<{ token?: string; error?: string }> {
  if (!allowed()) return { error: 'disabled' }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).finally(() => clearTimeout(t))
    if (res.status === 204) return {}
    const json = (await res.json().catch(() => ({}))) as { token?: string; error?: string }
    if (!res.ok) return { error: json.error ?? 'network' }
    return json
  } catch {
    return { error: 'offline' }
  }
}

// GET helper for the device-bound status poll.
async function getJson(path: string): Promise<{ active?: boolean; token?: string; error?: string }> {
  if (!allowed()) return { error: 'disabled' }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    const res = await fetch(`${API_BASE}${path}`, { signal: ctrl.signal }).finally(() => clearTimeout(t))
    const json = (await res.json().catch(() => ({}))) as { active?: boolean; token?: string; error?: string }
    if (!res.ok) return { error: json.error ?? 'network' }
    return json
  } catch {
    return { error: 'offline' }
  }
}

/**
 * The stored entitlement token (the compact Ed25519 token minted by our API), or null when
 * none is stored. Other main-process features (e.g. the relay pairing call) read this to prove
 * entitlement to the server. Returns the raw stored value — verify with `isPremium()` for gating.
 */
export function getStoredEntitlement(): string | null {
  return load().token ?? null
}

/** True when a valid, unexpired Pro entitlement is stored (offline-verified). Gates premium features. */
export function isPremium(): boolean {
  return verify(load().token) !== null
}

export function initLicense(win: BrowserWindow): void {
  const deviceId = getDeviceId()
  const broadcast = (s: LicenseStatus) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.licenseChanged, s)
  }

  ipcMain.handle(IPC.licenseStatus, () => statusFrom(load().token))

  // Device-bound upgrade: open Stripe checkout (carrying our deviceId), then poll the status
  // endpoint until the webhook has bound + minted the entitlement. Status arrives via broadcast.
  let polling = false
  ipcMain.handle(IPC.licenseUpgrade, async () => {
    const url = `${CHECKOUT_URL}${CHECKOUT_URL.includes('?') ? '&' : '?'}client_reference_id=${encodeURIComponent(deviceId)}`
    await shell.openExternal(url)
    if (!polling) {
      polling = true
      const deadline = Date.now() + 6 * 60 * 1000 // poll up to 6 min after opening checkout
      const poll = async (): Promise<void> => {
        if (Date.now() > deadline) {
          polling = false
          return
        }
        const r = await getJson(`/v1/license/status?deviceId=${encodeURIComponent(deviceId)}`)
        if (r.active && r.token) {
          await save({ key: load().key, token: r.token })
          broadcast(statusFrom(r.token))
          polling = false
          return
        }
        setTimeout(() => void poll(), 4000)
      }
      setTimeout(() => void poll(), 4000)
    }
    return statusFrom(load().token)
  })

  ipcMain.handle(IPC.licenseActivate, async (_e, key: string) => {
    const r = await call('/v1/license/activate', { key: String(key).trim(), deviceId })
    if (r.token) await save({ key: String(key).trim(), token: r.token })
    const status = statusFrom(r.token, r.error ?? null)
    broadcast(status)
    return status
  })

  ipcMain.handle(IPC.licenseDeactivate, async () => {
    const stored = load()
    if (stored.key) await call('/v1/license/deactivate', { key: stored.key, deviceId })
    await save({})
    const status = statusFrom(undefined)
    broadcast(status)
    return status
  })

  // On launch: re-establish entitlement, keeping the last valid token on failure (offline grace).
  void (async () => {
    const stored = load()
    if (stored.key) {
      // Key-paste flow: refresh against the stored key.
      const r = await call('/v1/license/refresh', { key: stored.key, deviceId })
      if (r.token) {
        await save({ key: stored.key, token: r.token })
        broadcast(statusFrom(r.token))
      } else {
        broadcast(statusFrom(stored.token, r.error ?? null)) // offline grace
      }
    } else {
      // Device-bound flow (no key): re-poll status by deviceId. Covers a purchase that completed
      // after the in-app Upgrade poll window, and every later relaunch.
      const r = await getJson(`/v1/license/status?deviceId=${encodeURIComponent(deviceId)}`)
      if (r.active && r.token) {
        await save({ key: stored.key, token: r.token })
        broadcast(statusFrom(r.token))
      } else if (r.error === 'offline' || r.error === 'network' || r.error === 'disabled') {
        // Couldn't reach the server → offline grace: keep the last valid token.
        if (stored.token) broadcast(statusFrom(stored.token))
      } else {
        // Server responded: this device is no longer entitled (canceled / suspended / expired)
        // → drop Pro and clear the cached token, even though it hasn't expired yet.
        if (stored.token) await save({ key: stored.key })
        broadcast(statusFrom(undefined))
      }
    }
  })()
}
