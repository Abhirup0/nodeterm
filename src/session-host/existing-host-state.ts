// Fail-closed ownership-state reads for the standalone session-host startup race.  A startup
// lock can be absent, but a lock that exists and cannot be understood is still evidence that
// another process may own it.  Treating those two facts alike lets a second host reclaim or
// overwrite ownership that it never proved stale.

import fs from 'fs'
import type { SessionHostState } from './paths'

export interface ExistingSessionHostIdentity {
  kind: 'ready'
  state: SessionHostState
  token: string
}

export interface MissingSessionHostIdentity {
  kind: 'absent'
  missing: 'state' | 'token'
}

export type ExistingSessionHostRead =
  | ExistingSessionHostIdentity
  | MissingSessionHostIdentity

export interface ExistingSessionHostReadOptions {
  /** Paths derived independently from the caller's userDataDir. Never trust redirects in state. */
  expectedEndpoint: string
  expectedTokenPath: string
  /** Deterministic filesystem seam for the failure-mode Chuts. */
  readText?: (filePath: string) => string
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function invalidState(detail: string): Error {
  return new Error(`invalid session-host state: ${detail}`)
}

function parseState(raw: string): SessionHostState {
  if (raw.trim().length === 0) throw invalidState('file is empty')

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw invalidState('file is not valid JSON')
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidState('root must be an object')
  }
  const state = value as Partial<SessionHostState>
  if (!Number.isInteger(state.pid) || (state.pid ?? 0) <= 0) {
    throw invalidState('pid must be a positive integer')
  }
  if (typeof state.endpoint !== 'string' || state.endpoint.trim().length === 0) {
    throw invalidState('endpoint must be a non-empty string')
  }
  if (typeof state.tokenPath !== 'string' || state.tokenPath.trim().length === 0) {
    throw invalidState('tokenPath must be a non-empty string')
  }
  if (
    typeof state.startedAt !== 'number' ||
    !Number.isFinite(state.startedAt) ||
    state.startedAt < 0
  ) {
    throw invalidState('startedAt must be a finite non-negative number')
  }
  if (
    !Number.isInteger(state.protocolVersion) ||
    (state.protocolVersion ?? 0) <= 0
  ) {
    throw invalidState('protocolVersion must be a positive integer')
  }

  return state as SessionHostState
}

/**
 * Read the ownership state and its referenced bearer token as one fail-closed observation.
 *
 * Only `ENOENT` is absence. Permission errors, directories in place of files, I/O errors,
 * malformed state, and empty state/token files all throw, so a caller cannot accidentally use
 * them as permission to reclaim the startup lock or launch a competing host.
 */
export function readExistingSessionHostIdentity(
  statePath: string,
  options: ExistingSessionHostReadOptions
): ExistingSessionHostRead {
  const readText = options.readText ?? ((filePath) => fs.readFileSync(filePath, 'utf8'))

  let rawState: string
  try {
    rawState = readText(statePath)
  } catch (error) {
    if (isEnoent(error)) return { kind: 'absent', missing: 'state' }
    throw error
  }

  const state = parseState(rawState)
  if (state.endpoint !== options.expectedEndpoint) {
    throw invalidState('endpoint does not match the derived endpoint')
  }
  if (state.tokenPath !== options.expectedTokenPath) {
    throw invalidState('tokenPath does not match the derived token path')
  }
  let token: string
  try {
    token = readText(state.tokenPath)
  } catch (error) {
    if (isEnoent(error)) return { kind: 'absent', missing: 'token' }
    throw error
  }
  if (token.trim().length === 0) throw new Error('invalid session-host token: file is empty')
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new Error('invalid session-host token: expected 64 lowercase hexadecimal characters')
  }

  return { kind: 'ready', state, token }
}
