import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  codexIdentityCaps,
  refreshCodexIdentityCaps,
  resetCodexIdentityCapsForTests
} from './codex-identity-caps'
import {
  resetCodexThreadIdentityAuthSecret,
  setCodexThreadIdentityAuthSecret
} from './codex-identity-proxy'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-caps-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  resetCodexIdentityCapsForTests()
  resetCodexThreadIdentityAuthSecret()
})

afterEach(() => {
  resetCodexThreadIdentityAuthSecret()
  resetCodexIdentityCapsForTests()
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('codexIdentityCaps', () => {
  it('says yes, and installs the launcher, once the secret is in', () => {
    setCodexThreadIdentityAuthSecret(randomBytes(32))
    const caps = refreshCodexIdentityCaps()
    expect(caps.shared).toBe(true)
    expect(fs.existsSync(caps.launcherPath as string)).toBe(true)
  })

  it('says no without the secret, and installs nothing', () => {
    // Half-armed is the state to avoid: a launcher on PATH with no capability to present would
    // reach the routes, be refused, and fall back one process later. Better to never name it.
    const caps = refreshCodexIdentityCaps()
    expect(caps).toEqual({ shared: false, launcherPath: null })
    expect(fs.existsSync(path.join(dir, 'codex-bin', 'nodeterm-codex'))).toBe(false)
  })

  it('makes an early caller WAIT rather than answering no', async () => {
    // The ordering trap this exists for: a sync getter would answer `false` to anything that asked
    // before the shell refreshed, and a `false` pins the feature off for the whole run — with no
    // launcher run there is no chip, no toast and no log line to say it happened.
    const asked = codexIdentityCaps()
    let settled = false
    void asked.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    setCodexThreadIdentityAuthSecret(randomBytes(32))
    refreshCodexIdentityCaps()
    expect((await asked).shared).toBe(true)
  })

  it('answers immediately once refreshed', async () => {
    refreshCodexIdentityCaps()
    expect(await codexIdentityCaps()).toEqual({ shared: false, launcherPath: null })
  })
})
