import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import {
  publishSessionHostState,
  renameSessionHostStateAtomic,
  sessionHostStateTempName
} from './state-file'

function codedError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: injected`)
  error.code = code
  return error
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nt-session-host-state-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('session-host state publication', () => {
  it('keeps process identity visible in otherwise unique temp paths', () => {
    const target = path.join(dir, 'session-host.json')
    const a = sessionHostStateTempName(target, { pid: 101, sequence: 1, uuid: () => 'uuid-a' })
    const b = sessionHostStateTempName(target, { pid: 202, sequence: 1, uuid: () => 'uuid-b' })

    expect(a).not.toBe(b)
    expect(a).toContain('.101.')
    expect(b).toContain('.202.')
    expect(a.endsWith('.tmp')).toBe(true)
    expect(b.endsWith('.tmp')).toBe(true)
  })
  it('gives colliding PID namespaces and module counters different temp paths', () => {
    const target = path.join(dir, 'session-host.json')
    const sameNamespace = { pid: 1, sequence: 1 }
    const defaultUuidA = sessionHostStateTempName(target, sameNamespace)
    const defaultUuidB = sessionHostStateTempName(target, sameNamespace)
    expect(defaultUuidA).not.toBe(defaultUuidB)
    const a = sessionHostStateTempName(target, { ...sameNamespace, uuid: () => 'uuid-a' })
    const b = sessionHostStateTempName(target, { ...sameNamespace, uuid: () => 'uuid-b' })

    expect(a).not.toBe(b)
    expect(a).toContain('.1.1.uuid-a.tmp')
    expect(b).toContain('.1.1.uuid-b.tmp')
    expect(a.endsWith('.tmp')).toBe(true)
    expect(b.endsWith('.tmp')).toBe(true)
  })

  it('retries transient Windows sharing violations before atomically replacing the lock file', () => {
    const target = path.join(dir, 'session-host.json')
    writeFileSync(target, '') // the exclusive-create startup lock this publication replaces
    let attempts = 0
    const waits: number[] = []

    publishSessionHostState(target, '{"pid":42}', {
      rename: (from, to) => {
        if (++attempts <= 2) throw codedError('EPERM')
        renameSync(from, to)
      },
      wait: (ms) => waits.push(ms)
    })

    expect(attempts).toBe(3)
    expect(waits).toEqual([10, 25])
    expect(readFileSync(target, 'utf8')).toBe('{"pid":42}')
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('leaves the old lock/state intact and removes its own temp on a permanent failure', () => {
    const target = path.join(dir, 'session-host.json')
    writeFileSync(target, 'old-state')

    expect(() =>
      publishSessionHostState(target, 'replacement', {
        rename: () => {
          throw codedError('ENOSPC')
        },
        wait: () => {
          throw new Error('a permanent failure must not spend the retry budget')
        }
      })
    ).toThrow(/ENOSPC/)
    expect(readFileSync(target, 'utf8')).toBe('old-state')
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('renameSessionHostStateAtomic', () => {
  it('does not let one unfixable result block startup forever', () => {
    let attempts = 0
    expect(() =>
      renameSessionHostStateAtomic('tmp', 'target', {
        rename: () => {
          attempts++
          throw codedError('ENOENT')
        },
        wait: () => {
          throw new Error('ENOENT must not wait')
        }
      })
    ).toThrow(/ENOENT/)
    expect(attempts).toBe(1)
  })
})
