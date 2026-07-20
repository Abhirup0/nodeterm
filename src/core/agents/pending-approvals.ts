// Deterministic hook-reply approvals — the answer-file side (docs/hook-reply-approvals.md).
//
// The managed permission hook (managed-script.ts) holds an incoming PermissionRequest open and
// polls `<home>/.nodeterm/pending/<pendingId>.answer` for a one-line `allow` | `deny`. This module
// writes that answer file (LOCAL fs — the host the agent runs on for a local project) and sweeps
// stale request files left by killed/timed-out sessions.
//
// Electron-free (fs/path/os only), so both shells boot it. Every function fails soft: an invalid
// pendingId or an fs error resolves false / logs, never throws.

import fs from 'fs'
import os from 'os'
import path from 'path'

/** pendingId shape the script generates (`<node>-<ms>-<pid>`) and the ONLY thing we interpolate
 *  into a filename. Validated everywhere a pendingId becomes a path so a forged value can't
 *  traverse (`../`) or inject. Keep in sync with the managed script's `tr -c 'A-Za-z0-9_-'`. */
export const PENDING_ID_RE = /^[A-Za-z0-9_-]+$/

/** How old a request (`.json`) / answer (`.answer`) file may get before the sweeper removes it. */
export const PENDING_MAX_AGE_MS = 10 * 60_000
/** Sweep cadence (boot + this interval). */
export const PENDING_SWEEP_INTERVAL_MS = 60 * 60_000

export function isValidPendingId(pendingId: string): boolean {
  return typeof pendingId === 'string' && pendingId.length > 0 && pendingId.length <= 256 && PENDING_ID_RE.test(pendingId)
}

/** `<home>/.nodeterm/pending`. `homeDir` is injected so tests never touch the real home. */
export function pendingDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.nodeterm', 'pending')
}

/**
 * Write the one-line answer file for a held permission hook, atomically (tmp + rename, mode 0600).
 * Resolves true on success, false on an invalid pendingId or any fs error (fail-open — the hook
 * simply times out to the interactive prompt). The `decision` is written verbatim as the hook
 * script compares it against the literals `allow` / `deny`.
 */
export async function writePendingAnswerLocal(
  pendingId: string,
  decision: 'allow' | 'deny',
  homeDir: string = os.homedir()
): Promise<boolean> {
  if (!isValidPendingId(pendingId)) return false
  if (decision !== 'allow' && decision !== 'deny') return false
  const dir = pendingDir(homeDir)
  const file = path.join(dir, `${pendingId}.answer`)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.promises.writeFile(tmp, decision, { mode: 0o600 })
    await fs.promises.rename(tmp, file)
    return true
  } catch {
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
    return false
  }
}

/**
 * Remove `.json` / `.answer` files under the pending dir older than `maxAgeMs` (orphans from killed
 * or timed-out sessions). Returns the count removed. Best-effort — a missing dir or unreadable
 * entry is silently skipped. Pure w.r.t. its `now`/`homeDir` inputs for testing.
 */
export async function sweepPendingDir(
  now: number = Date.now(),
  maxAgeMs: number = PENDING_MAX_AGE_MS,
  homeDir: string = os.homedir()
): Promise<number> {
  const dir = pendingDir(homeDir)
  let removed = 0
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return 0 // no dir yet / unreadable
  }
  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.answer')) continue
    const p = path.join(dir, name)
    try {
      const st = await fs.promises.stat(p)
      if (now - st.mtimeMs > maxAgeMs) {
        await fs.promises.rm(p, { force: true })
        removed++
      }
    } catch {
      // Raced deletion / stat error: skip.
    }
  }
  return removed
}

export interface PendingSweeperHandle {
  stop(): void
}

/**
 * Start the pending-dir sweeper: one sweep now, then every `intervalMs`. The interval is unref'd so
 * it never keeps the process alive. Wired once per shell on boot.
 */
export function startPendingSweep(
  homeDir: string = os.homedir(),
  intervalMs: number = PENDING_SWEEP_INTERVAL_MS
): PendingSweeperHandle {
  void sweepPendingDir(Date.now(), PENDING_MAX_AGE_MS, homeDir).catch(() => {})
  const timer = setInterval(() => {
    void sweepPendingDir(Date.now(), PENDING_MAX_AGE_MS, homeDir).catch(() => {})
  }, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
