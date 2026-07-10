// Disk read/write for the standing (phone) host's pinned-device list. The pure pin/lookup logic
// lives in `approved-devices-core.ts`; this only touches the filesystem.
//
// Stored at <userData>/remote-approved-devices.json. The contents are PUBLIC keys (device box
// public keys the host has approved once), never credentials.

import { promises as fs } from 'fs'
import path from 'path'
import { app } from 'electron'
import {
  emptyApprovedDevices,
  parseApprovedDevices,
  type ApprovedDevices
} from './approved-devices-core'

function file(): string {
  return path.join(app.getPath('userData'), 'remote-approved-devices.json')
}

/** Load the pinned-device list; returns an empty list when the file is absent or malformed. */
export async function loadApprovedDevices(): Promise<ApprovedDevices> {
  try {
    return parseApprovedDevices(JSON.parse(await fs.readFile(file(), 'utf-8')))
  } catch {
    return emptyApprovedDevices()
  }
}

/** Persist the pinned-device list atomically (temp + rename, 0600). */
export async function saveApprovedDevices(store: ApprovedDevices): Promise<void> {
  const target = file()
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, JSON.stringify(store), { encoding: 'utf-8', mode: 0o600 })
  await fs.rename(tmp, target)
}
