import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

let userData = ''
let encryptionAvailable = true
const flip = (value: Buffer) => Buffer.from(value.map((byte) => byte ^ 0xff))

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => flip(Buffer.from(value, 'utf8')),
    decryptString: (value: Buffer) => flip(value).toString('utf8')
  }
}))

import { loadOrCreateCodexNodeAuthSecret, resetCodexNodeAuthSecretForTests } from './codex-node-auth-secret'

const file = () => path.join(userData, 'codex-node-auth-key.json')

describe('Codex node-auth secret', () => {
  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-codex-node-auth-'))
    encryptionAvailable = true
    resetCodexNodeAuthSecretForTests()
  })

  afterEach(async () => {
    await fs.rm(userData, { recursive: true, force: true })
  })

  it('persists only keychain ciphertext and restores the same secret after restart', async () => {
    const first = await loadOrCreateCodexNodeAuthSecret()
    const stored = JSON.parse(await fs.readFile(file(), 'utf8')) as Record<string, unknown>
    expect(first).toHaveLength(32)
    expect(stored).toEqual({ version: 1, secretKeyEnc: expect.any(String) })
    expect(JSON.stringify(stored)).not.toContain(first.toString('base64'))
    expect((await fs.stat(file())).mode & 0o777).toBe(0o600)
    resetCodexNodeAuthSecretForTests()
    expect(await loadOrCreateCodexNodeAuthSecret()).toEqual(first)
  })

  it('fails closed without an OS keychain and writes no plaintext fallback', async () => {
    encryptionAvailable = false
    await expect(loadOrCreateCodexNodeAuthSecret()).rejects.toThrow('OS keychain is unavailable')
    await expect(fs.access(file())).rejects.toThrow()
  })

  it('fails closed on malformed persisted state instead of rotating ownership', async () => {
    await fs.writeFile(file(), '{"version":1,"secretKeyEnc":"broken"}\n', {
      mode: 0o600
    })
    await expect(loadOrCreateCodexNodeAuthSecret()).rejects.toThrow()
    expect(await fs.readFile(file(), 'utf8')).toBe('{"version":1,"secretKeyEnc":"broken"}\n')
  })
})
