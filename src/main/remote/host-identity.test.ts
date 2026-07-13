// The HOST's long-lived identity: the key every paired peer PINS. Losing it is not a recoverable
// blip — every peer must re-approve — so the one thing these tests really guard is that we never
// write over a key we merely cannot READ right now (locked keyring). Mirrors peer-identity.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

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

import { loadOrCreateHostKeyPair, HostKeyLockedError, resetHostKeyCache } from './host-identity'
import { publicKeyToB64 } from './e2ee'

const hostPath = () => path.join(userData, 'remote-host-key.json')
const readFile = async () => JSON.parse(await fs.readFile(hostPath(), 'utf-8'))
/** Drop the in-process cache — i.e. simulate an app restart. */
const restart = () => resetHostKeyCache()

describe('host-identity: persistent host keypair', () => {
  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-host-'))
    encryptionAvailable = false
    resetHostKeyCache()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(userData, { recursive: true, force: true })
  })

  it('generates and persists a keypair on first use, 0600', async () => {
    const keys = await loadOrCreateHostKeyPair()
    expect(keys.publicKey).toHaveLength(32)
    expect((await readFile()).publicKey).toBe(publicKeyToB64(keys.publicKey))
    expect((await fs.stat(hostPath())).mode & 0o777).toBe(0o600)
  })

  it('returns the SAME public key across restarts (the pinned identity is stable)', async () => {
    const first = await loadOrCreateHostKeyPair()
    restart()
    const second = await loadOrCreateHostKeyPair()
    expect(publicKeyToB64(second.publicKey)).toBe(publicKeyToB64(first.publicKey))
    expect(Buffer.from(second.secretKey)).toEqual(Buffer.from(first.secretKey))
  })

  it('does not collide with the peer key file', async () => {
    await loadOrCreateHostKeyPair()
    await expect(fs.access(path.join(userData, 'remote-peer-key.json'))).rejects.toThrow()
  })

  it('writes the legacy plaintext shape when no keyring is available (byte-compatible)', async () => {
    const keys = await loadOrCreateHostKeyPair()
    const onDisk = await readFile()
    expect(Object.keys(onDisk).sort()).toEqual(['publicKey', 'secretKey'])
    expect(onDisk.secretKey).toBe(Buffer.from(keys.secretKey).toString('base64'))
  })

  it('encrypts the secret at rest when safeStorage is available', async () => {
    encryptionAvailable = true
    const keys = await loadOrCreateHostKeyPair()
    const onDisk = await readFile()
    expect(onDisk.secretKey).toBeUndefined()
    expect(onDisk.secretKeyEnc).toBeTypeOf('string')
    restart()
    expect(Buffer.from((await loadOrCreateHostKeyPair()).secretKey)).toEqual(
      Buffer.from(keys.secretKey)
    )
  })

  it('migrates a legacy plaintext file in place, KEEPING the identity', async () => {
    const first = await loadOrCreateHostKeyPair()
    encryptionAvailable = true
    restart()
    const second = await loadOrCreateHostKeyPair()
    expect(publicKeyToB64(second.publicKey)).toBe(publicKeyToB64(first.publicKey))
    const onDisk = await readFile()
    expect(onDisk.secretKey).toBeUndefined()
    expect(onDisk.secretKeyEnc).toBeTypeOf('string')
  })

  it('regenerates when the stored file is corrupt', async () => {
    const first = await loadOrCreateHostKeyPair()
    await fs.writeFile(hostPath(), '{"publicKey":"zzz","secretKey":"@@@"}', 'utf-8')
    restart()
    const second = await loadOrCreateHostKeyPair()
    expect(second.publicKey).toHaveLength(32)
    expect(publicKeyToB64(second.publicKey)).not.toBe(publicKeyToB64(first.publicKey))
  })

  // --- obligation 5: a locked keyring must NEVER rotate the host identity ----------------------
  it('a locked keyring NEVER overwrites the encrypted host key (obligation 5)', async () => {
    // Arrange: an encrypted key file written while the keyring was available.
    encryptionAvailable = true
    const first = await loadOrCreateHostKeyPair()
    const before = await fs.readFile(hostPath(), 'utf-8')
    restart()

    // Act: reboot with the keyring locked (gnome-keyring not yet unlocked, no session bus).
    encryptionAvailable = false
    await expect(loadOrCreateHostKeyPair()).rejects.toMatchObject({ code: 'E_HOST_KEY_LOCKED' })
    await expect(loadOrCreateHostKeyPair()).rejects.toBeInstanceOf(HostKeyLockedError)

    // Assert: the identity is intact on disk — byte for byte — and recoverable once unlocked.
    expect(await fs.readFile(hostPath(), 'utf-8')).toBe(before)
    encryptionAvailable = true
    restart()
    expect(publicKeyToB64((await loadOrCreateHostKeyPair()).publicKey)).toBe(
      publicKeyToB64(first.publicKey)
    )
  })

  it('does not cache the failure: a later call succeeds once the keyring is back', async () => {
    encryptionAvailable = true
    const original = await loadOrCreateHostKeyPair()
    encryptionAvailable = false
    restart()
    await expect(loadOrCreateHostKeyPair()).rejects.toThrow(/keyring/i)
    // No restart(): the user unlocks the keyring and re-enables hosting in the SAME app run.
    encryptionAvailable = true
    const again = await loadOrCreateHostKeyPair()
    expect(publicKeyToB64(again.publicKey)).toBe(publicKeyToB64(original.publicKey))
  })

  it('two concurrent callers share ONE keypair and write the file once', async () => {
    const write = vi.spyOn(fs, 'writeFile')
    const [a, b] = await Promise.all([loadOrCreateHostKeyPair(), loadOrCreateHostKeyPair()])
    expect(publicKeyToB64(a.publicKey)).toBe(publicKeyToB64(b.publicKey))
    expect(write).toHaveBeenCalledTimes(1)
    expect((await readFile()).publicKey).toBe(publicKeyToB64(a.publicKey))
  })

  it('tightens a pre-existing 0644 file to 0600 on migration', async () => {
    await loadOrCreateHostKeyPair()
    await fs.chmod(hostPath(), 0o644)
    encryptionAvailable = true
    restart()
    await loadOrCreateHostKeyPair()
    expect((await fs.stat(hostPath())).mode & 0o777).toBe(0o600)
  })
})
