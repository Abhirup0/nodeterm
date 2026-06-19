// License/premium client. Runs in the main process: stores the key + last entitlement token,
// activates/refreshes against our API, and verifies the token OFFLINE with the embedded
// Ed25519 public key. Offline grace: a still-unexpired stored token keeps premium alive when
// a refresh can't reach the server.
import { promises as fs, readFileSync } from 'fs'
import path from 'path'
import crypto from 'node:crypto'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { LicenseStatus } from '../shared/types'
import { getDeviceId } from './device-id'
import { ENTITLEMENT_PUBLIC_KEY } from './entitlement-key'

const API_BASE = process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev'

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

export function initLicense(win: BrowserWindow): void {
  const deviceId = getDeviceId()
  const broadcast = (s: LicenseStatus) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.licenseChanged, s)
  }

  ipcMain.handle(IPC.licenseStatus, () => statusFrom(load().token))

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

  // On launch: refresh the token if we have a key, but keep the last valid token on failure.
  void (async () => {
    const stored = load()
    if (!stored.key) return
    const r = await call('/v1/license/refresh', { key: stored.key, deviceId })
    if (r.token) {
      await save({ key: stored.key, token: r.token })
      broadcast(statusFrom(r.token))
    } else {
      broadcast(statusFrom(stored.token, r.error ?? null)) // offline grace
    }
  })()
}
