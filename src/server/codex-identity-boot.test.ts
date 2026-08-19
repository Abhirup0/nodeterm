/**
 * Server Edition arms the Codex identity-auth secret on boot (S6 Decision 1; carried PR-2
 * obligation). Before PR 5 the headless shell armed ONLY `hookServer.setNodeAuthSecret(...)` and
 * never `setCodexThreadIdentityAuthSecret(...)`, so a MANAGED Codex account's thread→node→account
 * ownership record threw "NodeTerm Codex identity authentication is unavailable" the moment it
 * tried to sign — the record layer was dead on every headless host.
 *
 * The invariant pinned here: run the EXACT boot sequence src/server/index.ts runs after
 * `hookServer.start()`, and a managed-account resolve signs + round-trips instead of throwing.
 * MUTATION (recorded in the PR body): delete the `setCodexThreadIdentityAuthSecret(secret)` line in
 * src/server/index.ts (equivalently, drop it from the boot sequence below) → this suite goes red
 * because `writeCodexThreadIdentity` for a managed account throws "unavailable".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import { loadOrCreateNodeAuthSecret, resetNodeAuthSecretForTests } from '../core/agents/node-auth-secret'
import {
  setCodexThreadIdentityAuthSecret,
  resetCodexThreadIdentityAuthSecret,
  codexThreadIdentityAvailable,
  writeCodexThreadIdentity,
  resolveCodexThreadNodeIdentity,
  codexThreadIdentityRoot
} from '../core/codex-identity-proxy'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-server-codex-ident-'))
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
  it('a managed-account record signs + resolves after the boot sequence, instead of throwing unavailable', async () => {
    // Before arming: the record layer is dead.
    expect(codexThreadIdentityAvailable()).toBe(false)
    expect(() =>
      writeCodexThreadIdentity('thread-a', 'node-1', '/hook', undefined, 'managed-account')
    ).toThrow(/identity authentication is unavailable/)

    // The EXACT boot sequence src/server/index.ts runs after hookServer.start().
    const secret = await loadOrCreateNodeAuthSecret()
    setCodexThreadIdentityAuthSecret(secret)

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
