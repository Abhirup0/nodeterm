import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

// A real temp userData dir + a swappable fake keychain. Both are read lazily inside the mock, so
// vitest's hoisting of `vi.mock` above the imports is harmless.
let userData = ''
let encryptionAvailable = false

const flip = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0xff))

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s: string) => flip(Buffer.from(s, 'utf-8')),
    decryptString: (b: Buffer) => flip(b).toString('utf-8')
  }
}))

import { loadOrCreatePeerKeyPair } from './peer-identity'
import { publicKeyToB64 } from './e2ee'

const PEER_FILE = 'remote-peer-key.json'
const peerPath = () => path.join(userData, PEER_FILE)
const readFile = async () => JSON.parse(await fs.readFile(peerPath(), 'utf-8'))

describe('peer-identity: persistent client keypair', () => {
  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-peer-'))
    encryptionAvailable = false // plaintext path: no keyring needed in CI
  })
  afterEach(async () => {
    await fs.rm(userData, { recursive: true, force: true })
  })

  it('generates and persists a keypair on first use', async () => {
    const keys = await loadOrCreatePeerKeyPair()
    expect(keys.publicKey).toHaveLength(32)
    expect(keys.secretKey).toHaveLength(32)
    const onDisk = await readFile()
    expect(onDisk.publicKey).toBe(publicKeyToB64(keys.publicKey))
  })

  it('returns the SAME public key across "reconnects" (repeated loads)', async () => {
    const first = await loadOrCreatePeerKeyPair()
    const second = await loadOrCreatePeerKeyPair()
    const third = await loadOrCreatePeerKeyPair()
    expect(publicKeyToB64(second.publicKey)).toBe(publicKeyToB64(first.publicKey))
    expect(publicKeyToB64(third.publicKey)).toBe(publicKeyToB64(first.publicKey))
    expect(Buffer.from(second.secretKey)).toEqual(Buffer.from(first.secretKey))
  })

  it('does not collide with the host key file', async () => {
    await loadOrCreatePeerKeyPair()
    // The host identity lives in remote-host-key.json; the peer must use its OWN file.
    await expect(fs.access(path.join(userData, 'remote-host-key.json'))).rejects.toThrow()
  })

  it('writes the key file 0600', async () => {
    await loadOrCreatePeerKeyPair()
    const st = await fs.stat(peerPath())
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('encrypts the secret at rest when safeStorage is available', async () => {
    encryptionAvailable = true
    const keys = await loadOrCreatePeerKeyPair()
    const onDisk = await readFile()
    expect(onDisk.secretKey).toBeUndefined()
    expect(onDisk.secretKeyEnc).toBeTypeOf('string')
    // ...and still loads back to the same identity.
    const again = await loadOrCreatePeerKeyPair()
    expect(Buffer.from(again.secretKey)).toEqual(Buffer.from(keys.secretKey))
  })

  it('migrates a legacy plaintext file in place, KEEPING the identity', async () => {
    const first = await loadOrCreatePeerKeyPair() // written plaintext (no keyring)
    expect((await readFile()).secretKey).toBeTypeOf('string')
    encryptionAvailable = true // machine gains a keyring
    const second = await loadOrCreatePeerKeyPair()
    expect(publicKeyToB64(second.publicKey)).toBe(publicKeyToB64(first.publicKey))
    const onDisk = await readFile()
    expect(onDisk.secretKey).toBeUndefined()
    expect(onDisk.secretKeyEnc).toBeTypeOf('string')
  })

  it('regenerates and overwrites when the stored file is corrupt', async () => {
    const first = await loadOrCreatePeerKeyPair()
    await fs.writeFile(peerPath(), '{"publicKey":"zzz","secretKey":"@@@"}', 'utf-8')
    const second = await loadOrCreatePeerKeyPair()
    expect(second.publicKey).toHaveLength(32)
    expect(publicKeyToB64(second.publicKey)).not.toBe(publicKeyToB64(first.publicKey))
    // The fresh identity is persisted, so it is itself stable from here on.
    const third = await loadOrCreatePeerKeyPair()
    expect(publicKeyToB64(third.publicKey)).toBe(publicKeyToB64(second.publicKey))
  })
})
