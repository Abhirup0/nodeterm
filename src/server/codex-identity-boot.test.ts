/**
 * Server Edition arms the Codex identity-auth secret on boot (S6 Decision 1; carried PR-2
 * obligation). Before PR 5 the headless shell armed ONLY `hookServer.setNodeAuthSecret(...)` and
 * never `setCodexThreadIdentityAuthSecret(...)`, so a MANAGED Codex account's thread→node→account
 * ownership record threw "NodeTerm Codex identity authentication is unavailable" the moment it
 * tried to sign — the record layer was dead on every headless host.
 *
 * This drives the REAL production arming function `armServerNodeIdentity` (the exact code
 * `startServer` awaits in its node-identity try block), NOT a re-implementation of the boot
 * sequence — constraint 8 forbids a structural test that would pass the real defect.
 * MUTATION (recorded in the PR body): delete `setCodexThreadIdentityAuthSecret(nodeAuthSecret)` from
 * src/server/node-identity-arm.ts → this suite goes red because `writeCodexThreadIdentity` for a
 * managed account throws "unavailable". (Confirmed: the mutation now REDS the shipped path.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import { resetNodeAuthSecretForTests } from '../core/agents/node-auth-secret'
import {
  resetCodexThreadIdentityAuthSecret,
  codexThreadIdentityAvailable,
  writeCodexThreadIdentity,
  resolveCodexThreadNodeIdentity,
  codexThreadIdentityRoot
} from '../core/codex-identity-proxy'
import { armServerNodeIdentity } from './node-identity-arm'

let dir = ''
/** A hook-server stand-in capturing the node secret the real arming hands it. */
const hookServer = {
  received: null as Uint8Array | null,
  setNodeAuthSecret(secret: Uint8Array) {
    this.received = secret
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-server-codex-ident-'))
  hookServer.received = null
  resetPlatformForTests()
  resetNodeAuthSecretForTests()
  resetCodexThreadIdentityAuthSecret()
  // Server-Edition shape: no seal hooks, so the secret is stored raw (node-auth-key.bin).
  initPlatform(fakePlatform({ userDataDir: dir }))
})

afterEach(() => {
  resetPlatformForTests()
  resetNodeAuthSecretForTests()
  resetCodexThreadIdentityAuthSecret()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('Server Edition arms the Codex identity secret on boot', () => {
  it('a managed-account record signs + resolves after the REAL boot arming, instead of throwing unavailable', async () => {
    // Before arming: the record layer is dead.
    expect(codexThreadIdentityAvailable()).toBe(false)
    expect(() =>
      writeCodexThreadIdentity('thread-a', 'node-1', '/hook', undefined, 'managed-account')
    ).toThrow(/identity authentication is unavailable/)

    // Drive the REAL production arming `startServer` runs (no persisted canvases needed here).
    await armServerNodeIdentity(hookServer, () => [])

    // The node secret was armed too (both legs of the shipped function ran).
    expect(hookServer.received?.byteLength).toBe(32)
    expect(codexThreadIdentityAvailable()).toBe(true)

    // A MANAGED account (non-empty accountId) — the case that threw on a headless host — now signs
    // and round-trips against the real on-disk record under the fake platform's data dir.
    const root = codexThreadIdentityRoot()
    expect(() =>
      writeCodexThreadIdentity('thread-a', 'node-1', '/hook', root, 'managed-account')
    ).not.toThrow()
    expect(resolveCodexThreadNodeIdentity('thread-a', root, 'managed-account')).toBe('node-1')
    // And the SYSTEM account (no id) keeps resolving too — legacy-root records must not regress.
    writeCodexThreadIdentity('thread-b', 'node-2', '/hook', root)
    expect(resolveCodexThreadNodeIdentity('thread-b', root)).toBe('node-2')
  })
})
