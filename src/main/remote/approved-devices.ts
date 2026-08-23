// Disk read/write for the standing (phone) host's pinned-device list. The pure pin/lookup logic
// lives in `approved-devices-core.ts`; this only touches the filesystem.
//
// Stored at <userData>/remote-approved-devices.json. The contents are PUBLIC keys (device box
// public keys the host has approved once), never credentials.

import { promises as fs } from 'fs'
import path from 'path'
import { app } from 'electron'
import { writeFileAtomic } from '../../core/fs-atomic'
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

/**
 * Persist the pinned-device list atomically (unique temp + retrying rename, 0600) via
 * `writeFileAtomic`.
 *
 * The temp name is unique per call because three writers reach this from the main process with
 * nothing queueing them: the standing host's fire-and-forget pin on approval (standing-host.ts,
 * `void loadApprovedDevices().then(...)`), relay-trust's un-awaited pin when a mutual approval
 * settles, and the revoke IPC (src/main/index.ts → revocation.ts). With one shared `<file>.tmp`,
 * a writer's rename publishes the other's half-written list — or moves the file out from under it,
 * so the loser's rename fails.
 *
 * A failed write removes its own temp and rethrows, and the OLD file is left byte-for-byte
 * intact — revocation.ts's `persisted:false` contract depends on both halves.
 *
 * No orphan sweep here, unlike the PAT stores (src/main/github-control.ts, src/server/github-control.ts)
 * or agent.json (src/main/pairing-service.ts): those orphan temps hold live credentials, but these are
 * PUBLIC keys, so a stray temp is litter rather than a leak.
 */
export async function saveApprovedDevices(store: ApprovedDevices): Promise<void> {
  await writeFileAtomic(file(), JSON.stringify(store), { mode: 0o600 })
}
