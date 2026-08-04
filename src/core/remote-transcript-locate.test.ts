// The remote locator is generated shell — the compiler checks nothing about it, so these tests
// run the emitted command for REAL under /bin/sh against a fake host tree (same discipline as
// canvas-control-shim.test.ts and remote-claude-usage.test.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import {
  locateRemoteTranscriptCommand,
  parseLocatedTranscript,
  remoteTranscriptRoots
} from './remote-transcript-locate'
import { encodeTranscriptDir } from './transcript-reader'

const run = promisify(execFile)
const SID = '46b36ce2-dd77-4f5e-a89e-4a0e831e83df'

let home: string
const sh = async (cmd: string): Promise<string> => (await runShell(cmd)).stdout
/** Runs the generated command and reports the exit code instead of throwing on non-zero. */
const runShell = async (cmd: string): Promise<{ stdout: string; code: number }> => {
  try {
    const { stdout } = await run('/bin/sh', ['-c', cmd])
    return { stdout, code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; code?: number }
    return { stdout: err.stdout ?? '', code: err.code ?? 1 }
  }
}
const touch = (p: string, body = '{}\n'): void => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-remote-transcript-'))
})
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('remoteTranscriptRoots', () => {
  it('puts the account root before the system one and strips trailing slashes', () => {
    expect(remoteTranscriptRoots('/home/u/', '/home/u/.nodeterm/claude-accounts/acc1/')).toEqual([
      '/home/u/.nodeterm/claude-accounts/acc1/projects',
      '/home/u/.claude/projects'
    ])
  })
  it('is the system root alone without an account', () => {
    expect(remoteTranscriptRoots('/home/u')).toEqual(['/home/u/.claude/projects'])
  })
})

describe('locateRemoteTranscriptCommand', () => {
  it('refuses a session id that is not a session id (no command at all)', () => {
    expect(locateRemoteTranscriptCommand(['/r'], '/w', '../../etc/passwd')).toBeNull()
    expect(locateRemoteTranscriptCommand([], '/w', SID)).toBeNull()
  })

  it('finds the transcript at the exact cwd path', async () => {
    const cwd = '/srv/app.v2'
    const p = `${home}/.claude/projects/${encodeTranscriptDir(cwd)}/${SID}.jsonl`
    touch(p)
    const cmd = locateRemoteTranscriptCommand(remoteTranscriptRoots(home), cwd, SID)!
    expect(parseLocatedTranscript(await sh(cmd))).toBe(p)
  })

  it('falls back to the glob when the session lives under a DIFFERENT cwd', async () => {
    // The node's cwd and the session's cwd disagree (the user cd'ed) — the exact probe misses.
    const sid = '11111111-1111-4111-8111-111111111111'
    const p = `${home}/.claude/projects/-srv-elsewhere/${sid}.jsonl`
    touch(p)
    const cmd = locateRemoteTranscriptCommand(remoteTranscriptRoots(home), '/no/such/dir', sid)!
    expect(parseLocatedTranscript(await sh(cmd))).toBe(p)
  })

  it('prefers the managed account root over the system one', async () => {
    const sid = '22222222-2222-4222-8222-222222222222'
    const accDir = `${home}/.nodeterm/claude-accounts/acc1`
    const cwd = '/srv/shared'
    const enc = encodeTranscriptDir(cwd)
    touch(`${home}/.claude/projects/${enc}/${sid}.jsonl`)
    touch(`${accDir}/projects/${enc}/${sid}.jsonl`)
    const cmd = locateRemoteTranscriptCommand(remoteTranscriptRoots(home, accDir), cwd, sid)!
    expect(parseLocatedTranscript(await sh(cmd))).toBe(`${accDir}/projects/${enc}/${sid}.jsonl`)
  })

  // A clean miss must EXIT 0: main reads the path only when `code === 0`, and an ssh call that
  // reports failure for "this session has no transcript" is indistinguishable from a dead master.
  it('prints nothing and exits 0 when the session is on no root', async () => {
    const cmd = locateRemoteTranscriptCommand(
      [`${home}/.nowhere/projects`],
      '/srv/app',
      '33333333-3333-4333-8333-333333333333'
    )!
    const { stdout, code } = await runShell(cmd)
    expect(code).toBe(0)
    expect(parseLocatedTranscript(stdout)).toBeUndefined()
  })

  it('survives a home directory with a space (quoting, not word splitting)', async () => {
    const spaced = fs.mkdtempSync(path.join(os.tmpdir(), 'nt space '))
    try {
      const cwd = '/srv/app'
      const p = `${spaced}/.claude/projects/${encodeTranscriptDir(cwd)}/${SID}.jsonl`
      touch(p)
      const cmd = locateRemoteTranscriptCommand(remoteTranscriptRoots(spaced), cwd, SID)!
      expect(parseLocatedTranscript(await sh(cmd))).toBe(p)
    } finally {
      fs.rmSync(spaced, { recursive: true, force: true })
    }
  })
})
