// Anonymous, opt-out telemetry. Runs in the main process (like check.ts) so the
// renderer CSP stays 'self'. Sends version/OS on launch and once a day; nothing personal,
// and the client IP is never stored server-side.
import { promises as fs, readFileSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import type { Settings } from '../shared/types'

const API_BASE = process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev'
const DAY_MS = 24 * 60 * 60 * 1000
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1000 // client-side burst cap: never ping more often

// Hardening: never transmit unless it's an official
// build AND the user hasn't opted out AND no kill switch is set. A dev can target a local
// server by setting NODETERM_API_BASE explicitly.
function telemetryAllowed(getSettings: () => Settings): boolean {
  if (process.env.DO_NOT_TRACK || process.env.NODETERM_TELEMETRY_DISABLED) return false
  if (!app.isPackaged && !process.env.NODETERM_API_BASE) return false
  return getSettings().telemetryEnabled
}

// A stable anonymous id in its own file (kept out of the renderer-synced settings).
function getOrCreateDeviceId(): string {
  const file = path.join(app.getPath('userData'), 'device-id')
  try {
    const existing = readFileSync(file, 'utf-8').trim()
    if (existing) return existing
  } catch {
    // not created yet
  }
  const id = randomUUID()
  void fs.writeFile(file, id, 'utf-8').catch(() => {})
  return id
}

let lastSent = 0
async function ping(getSettings: () => Settings, deviceId: string): Promise<void> {
  if (!telemetryAllowed(getSettings)) return
  const now = Date.now()
  if (now - lastSent < MIN_INTERVAL_MS) return // burst cap
  lastSent = now
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 8000)
    await fetch(`${API_BASE}/v1/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        appVersion: app.getVersion(),
        os: process.platform,
        arch: process.arch,
        channel: 'stable'
      }),
      signal: ctrl.signal
    }).finally(() => clearTimeout(t))
  } catch {
    // Swallow — telemetry must never affect the app.
  }
}

export function initTelemetry(getSettings: () => Settings): void {
  const deviceId = getOrCreateDeviceId()
  void ping(getSettings, deviceId)
  setInterval(() => void ping(getSettings, deviceId), DAY_MS)
}
