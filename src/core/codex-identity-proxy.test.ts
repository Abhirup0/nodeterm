import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  bindCodexThreadIdentity,
  codexLauncherDir,
  codexThreadIdentityRoot,
  installCodexLauncher,
  readCodexThreadIdentity,
  resetCodexThreadIdentityAuthSecret,
  resolveCodexThreadNodeIdentity,
  setCodexThreadIdentityAuthSecret,
  writeCodexThreadIdentity
} from './codex-identity-proxy'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

let dir = ''
const live = (ids: string[]) => (id: string) => ids.includes(id)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-identity-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  setCodexThreadIdentityAuthSecret(randomBytes(32))
})

afterEach(() => {
  resetCodexThreadIdentityAuthSecret()
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('codex thread identity store', () => {
  it('lives under the platform data dir, not $HOME', () => {
    // The wrong seam is why the Server Edition had no story at all: `homedir()` is not where a
    // server keeps its state, and nothing behind CorePlatform can be swapped for it.
    expect(codexThreadIdentityRoot()).toBe(path.join(dir, 'codex-thread-nodes'))
    expect(codexLauncherDir()).toBe(path.join(dir, 'codex-bin'))
  })

  it('round-trips a record and resolves its owning node', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/hook-endpoint.env')
    expect(resolveCodexThreadNodeIdentity('thread-1')).toBe('node-1')
  })

  it('ignores a record whose node id was rewritten (the signature no longer matches)', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/hook-endpoint.env')
    const file = path.join(codexThreadIdentityRoot(), 'thread-1')
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('node-1', 'node-evil'))
    // Not repaired, not trusted: the prelude re-exports both fields into an agent's environment,
    // so an attacker-writable record is an attacker-chosen hook target.
    expect(readCodexThreadIdentity('thread-1')).toBeUndefined()
    expect(resolveCodexThreadNodeIdentity('thread-1')).toBeUndefined()
  })

  it('ignores an unsigned record', () => {
    fs.mkdirSync(codexThreadIdentityRoot(), { recursive: true })
    fs.writeFileSync(
      path.join(codexThreadIdentityRoot(), 'thread-1'),
      'nodeId=node-1\nendpoint=/data/hook-endpoint.env\n'
    )
    expect(resolveCodexThreadNodeIdentity('thread-1')).toBeUndefined()
  })

  it('refuses ids and endpoints that are not shaped like ids and endpoints', () => {
    expect(() => writeCodexThreadIdentity('../escape', 'node-1', '/data/e')).toThrow()
    expect(() => writeCodexThreadIdentity('thread-1', 'node 1; rm -rf /', '/data/e')).toThrow()
    expect(() => writeCodexThreadIdentity('thread-1', 'node-1', 'relative/e')).toThrow()
  })

  it('writes nothing at all without the auth secret', () => {
    resetCodexThreadIdentityAuthSecret()
    expect(() => writeCodexThreadIdentity('thread-1', 'node-1', '/data/e')).toThrow()
    expect(fs.existsSync(path.join(codexThreadIdentityRoot(), 'thread-1'))).toBe(false)
  })
})

describe('binding a thread to a node', () => {
  it('refuses to take a thread away from a node that is still live', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e')
    expect(() =>
      bindCodexThreadIdentity('thread-1', 'node-2', '/data/e', live(['node-1']))
    ).toThrow()
    expect(resolveCodexThreadNodeIdentity('thread-1')).toBe('node-1')
  })

  it('re-claims a thread whose owner is gone', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e')
    bindCodexThreadIdentity('thread-1', 'node-2', '/data/e', live([]))
    expect(resolveCodexThreadNodeIdentity('thread-1')).toBe('node-2')
  })

  it('is idempotent for the node that already owns it (a restart re-binds its own thread)', () => {
    writeCodexThreadIdentity('thread-1', 'node-1', '/data/e')
    bindCodexThreadIdentity('thread-1', 'node-1', '/data/e', live(['node-1']))
    expect(resolveCodexThreadNodeIdentity('thread-1')).toBe('node-1')
  })
})

describe('installCodexLauncher', () => {
  it('writes an executable launcher and answers with its path', () => {
    const file = installCodexLauncher()
    expect(file).toBe(path.join(codexLauncherDir(), 'nodeterm-codex'))
    expect(fs.statSync(file as string).mode & 0o777).toBe(0o700)
  })

  it('answers null instead of throwing when it cannot be written', () => {
    // A read-only data dir is a real failure mode, and null is what makes the caps probe say "no
    // shared identity" — which keeps every launch line on the bare `codex` instead of naming a
    // launcher that is not there.
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: path.join(dir, 'file-not-a-dir') }))
    fs.writeFileSync(path.join(dir, 'file-not-a-dir'), 'x')
    expect(installCodexLauncher()).toBeNull()
  })
})
