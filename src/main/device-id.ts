import { promises as fs, readFileSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { app } from 'electron'

// Stable anonymous machine id, persisted in userData (shared with telemetry).
export function getDeviceId(): string {
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
