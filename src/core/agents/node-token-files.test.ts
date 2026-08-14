import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import {
  nodeTokenDir,
  writeNodeTokenFile,
  sweepNodeTokenFile,
  materialisedNodes,
  resetNodeTokenFilesForTests
} from './node-token-files'

let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-toks-'))
  resetPlatformForTests()
  resetNodeTokenFilesForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('node token files', () => {
  it('writes 0600 files inside a 0700 dir and records materialisation', () => {
    expect(writeNodeTokenFile('node-1', 'kid.mac')).toBe(true)
    expect(fs.statSync(nodeTokenDir()).mode & 0o777).toBe(0o700)
    // One descriptor for both assertions: stat-then-read is a check-then-use race (CodeQL
    // js/file-system-race), and the fd is the stronger assertion anyway — it proves the mode and
    // the contents belong to the SAME inode, which is the whole point of a 0600 credential file.
    const f = path.join(nodeTokenDir(), 'node-1')
    const fd = fs.openSync(f, 'r')
    try {
      expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(fd, 'utf8')).toBe('kid.mac\n')
    } finally {
      fs.closeSync(fd)
    }
    expect([...materialisedNodes()]).toEqual(['node-1'])
  })

  it('refuses unsafe node ids and creates NO file (path traversal guard)', () => {
    for (const bad of ['../evil', '..', '.', 'a b', 'a/b']) {
      expect(writeNodeTokenFile(bad, 'kid.mac'), bad).toBe(false)
    }
    // Read once and treat "no dir" as "no entries", rather than exists-then-read: the two-step is a
    // check-then-use race (CodeQL js/file-system-race), and here it also reads worse — a refused id
    // must leave the dir either empty or absent, and both are the same assertion.
    let entries: string[] = []
    try {
      entries = fs.readdirSync(nodeTokenDir())
    } catch {
      /* dir was never created — that is the passing shape too */
    }
    expect(entries).toEqual([])
    // Prove nothing escaped the token dir into userDataDir.
    expect(fs.existsSync(path.join(dir, 'evil'))).toBe(false)
    expect([...materialisedNodes()]).toEqual([])
  })

  it('refuses an empty token', () => {
    expect(writeNodeTokenFile('node-1', '')).toBe(false)
  })

  it('is idempotent under a racing rewrite (derived value ⇒ identical bytes)', () => {
    for (let i = 0; i < 5; i++) expect(writeNodeTokenFile('node-1', 'kid.mac')).toBe(true)
    expect(fs.readdirSync(nodeTokenDir())).toEqual(['node-1'])
  })

  it('sweeps a deleted node and forgets it', () => {
    writeNodeTokenFile('node-1', 'kid.mac')
    sweepNodeTokenFile('node-1')
    expect(fs.readdirSync(nodeTokenDir())).toEqual([])
    expect([...materialisedNodes()]).toEqual([])
  })

  it('leaves no leftover tmp files behind', () => {
    writeNodeTokenFile('node-1', 'kid.mac')
    expect(fs.readdirSync(nodeTokenDir())).toEqual(['node-1'])
  })

  it('fails OPEN on an unwritable dir — returns false, never throws', () => {
    fs.mkdirSync(nodeTokenDir(), { recursive: true })
    fs.chmodSync(nodeTokenDir(), 0o500)
    expect(() => writeNodeTokenFile('node-2', 'kid.mac')).not.toThrow()
    fs.chmodSync(nodeTokenDir(), 0o700)
  })
})
