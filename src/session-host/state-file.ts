// Session-host-local atomic publication. This standalone bundle deliberately imports neither
// src/core nor Electron, so it cannot reuse core/fs-atomic.ts without breaking the process
// boundary documented in docs/windows-session-host.md. Keep this small twin behavior-identical:
// unique temp ownership, bounded Windows sharing-violation retries, cleanup on every failure.

import { renameSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RETRY_DELAYS_MS = [10, 25, 75, 200]
const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4))
let tempSequence = 0

function codeOf(error: unknown): string {
  return typeof error === 'object' && error && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
}

export interface SessionHostTempNameOptions {
  /** Deterministic seams for the collision gate; production leaves all three undefined. */
  pid?: number
  sequence?: number
  uuid?: () => string
}

/** The UUID separates PID namespaces, worker isolates, and PID reuse. PID/counter remain useful
 *  ownership metadata. A fixed `<state>.tmp` lets a second startup publish or remove the first
 *  one's bytes, especially after a stale-lock reclaim. */
export function sessionHostStateTempName(
  target: string,
  opts: SessionHostTempNameOptions = {}
): string {
  const pid = opts.pid ?? process.pid
  const sequence = opts.sequence ?? ++tempSequence
  const uuid = opts.uuid ?? randomUUID
  return `${target}.${pid}.${sequence}.${uuid()}.tmp`
}

export function renameSessionHostStateAtomic(
  tmp: string,
  target: string,
  deps: {
    rename?: (from: string, to: string) => void
    wait?: (ms: number) => void
  } = {}
): void {
  const rename = deps.rename ?? renameSync
  const wait = deps.wait ?? ((ms: number) => Atomics.wait(SLEEP_SLOT, 0, 0, ms))
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, target)
      return
    } catch (error) {
      if (
        attempt >= RETRY_DELAYS_MS.length ||
        !TRANSIENT_RENAME_CODES.has(codeOf(error))
      ) {
        throw error
      }
      wait(RETRY_DELAYS_MS[attempt])
    }
  }
}

/** Publish the fully-written state as one rename. The old state/lock file stays intact on any
 *  failure, and this process removes only the unique temp file it owns. */
export function publishSessionHostState(
  target: string,
  json: string,
  deps: {
    tempName?: (target: string) => string
    write?: (path: string, data: string) => void
    rename?: (from: string, to: string) => void
    remove?: (path: string) => void
    wait?: (ms: number) => void
  } = {}
): void {
  const tmp = (deps.tempName ?? sessionHostStateTempName)(target)
  const write =
    deps.write ??
    ((file: string, data: string) =>
      writeFileSync(file, data, { encoding: 'utf8', mode: 0o600 }))
  const remove = deps.remove ?? ((file: string) => rmSync(file, { force: true }))
  try {
    write(tmp, json)
    renameSessionHostStateAtomic(tmp, target, { rename: deps.rename, wait: deps.wait })
  } catch (error) {
    try {
      remove(tmp)
    } catch {
      /* best effort: never replace the original publication error with temp cleanup noise */
    }
    throw error
  }
}
