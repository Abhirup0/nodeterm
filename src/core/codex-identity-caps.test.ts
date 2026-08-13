import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  codexCliSupportsRemote,
  codexIdentityCaps,
  refreshCodexIdentityCaps,
  resetCodexIdentityCapsForTests
} from './codex-identity-caps'

/** Stand-in for the `codex --help` probe. Every test says explicitly what the CLI answered. */
const remote = (yes: boolean) => () => Promise.resolve(yes)
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
  it('says yes, and installs the launcher, once the secret is in and the CLI has --remote', async () => {
    setCodexThreadIdentityAuthSecret(randomBytes(32))
    const caps = await refreshCodexIdentityCaps(remote(true))
    expect(caps.shared).toBe(true)
    expect(fs.existsSync(caps.launcherPath as string)).toBe(true)
  })

  it('says no without the secret, and installs nothing', () => {
    // Half-armed is the state to avoid: a launcher on PATH with no capability to present would
    // reach the routes, be refused, and fall back one process later. Better to never name it.
    return refreshCodexIdentityCaps(remote(true)).then((caps) => {
      expect(caps).toEqual({ shared: false, launcherPath: null, remoteFlag: true })
      expect(fs.existsSync(path.join(dir, 'codex-bin', 'nodeterm-codex'))).toBe(false)
    })
  })

  it('says no when the installed codex has no --remote, however armed everything else is', async () => {
    // The one precondition with no runtime recovery: the launcher execs, and a CLI with an
    // app-server but no --remote dies on a usage error where nothing can fall back. Answering it
    // here turns a dead node into a plain-codex node on every machine, not just the tester's.
    setCodexThreadIdentityAuthSecret(randomBytes(32))
    const caps = await refreshCodexIdentityCaps(remote(false))
    expect(caps).toEqual({ shared: false, launcherPath: null, remoteFlag: false })
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
    await refreshCodexIdentityCaps(remote(true))
    expect((await asked).shared).toBe(true)
  })

  it('answers immediately once refreshed', async () => {
    await refreshCodexIdentityCaps(remote(false))
    expect(await codexIdentityCaps()).toEqual({
      shared: false,
      launcherPath: null,
      remoteFlag: false
    })
  })
})

describe('codexCliSupportsRemote', () => {
  it('reads the flag out of help text, and is not fooled by a longer flag or by prose', () => {
    expect(codexCliSupportsRemote('  --remote <URL>   connect to an app-server')).toBe(true)
    expect(codexCliSupportsRemote('  --remote=<URL>')).toBe(true)
    // `--remote-auth-token-env` exists and is NOT the flag we need; nor is a mention of it.
    expect(codexCliSupportsRemote('  --remote-auth-token-env <VAR>')).toBe(false)
    expect(codexCliSupportsRemote('use with --remotely-hosted servers')).toBe(false)
    expect(codexCliSupportsRemote(null, undefined, '')).toBe(false)
  })

  it('accepts an answer from either help page', () => {
    // Some CLIs list a global flag only under the subcommand that takes it.
    expect(codexCliSupportsRemote('no flags here', '  --remote <URL>')).toBe(true)
  })
})
