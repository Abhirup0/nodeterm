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

import { loadOrCreatePeerKeyPair, PeerKeyLockedError, resetPeerKeyCache } from './peer-identity'
import { publicKeyToB64 } from './e2ee'

const PEER_FILE = 'remote-peer-key.json'
const peerPath = () => path.join(userData, PEER_FILE)
const readFile = async () => JSON.parse(await fs.readFile(peerPath(), 'utf-8'))
// The key is loaded once per app run (in-process cache), so a test that simulates a RESTART — a
// changed keyring state, an externally rewritten file — has to drop it, like a new process would.
const restart = () => resetPeerKeyCache()

describe('peer-identity: persistent client keypair', () => {
  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-peer-'))
    encryptionAvailable = false // plaintext path: no keyring needed in CI
    resetPeerKeyCache()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
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
    restart()
    const again = await loadOrCreatePeerKeyPair()
    expect(Buffer.from(again.secretKey)).toEqual(Buffer.from(keys.secretKey))
  })

  it('migrates a legacy plaintext file in place, KEEPING the identity', async () => {
    const first = await loadOrCreatePeerKeyPair() // written plaintext (no keyring)
    expect((await readFile()).secretKey).toBeTypeOf('string')
    encryptionAvailable = true // machine gains a keyring
    restart()
    const second = await loadOrCreatePeerKeyPair()
    expect(publicKeyToB64(second.publicKey)).toBe(publicKeyToB64(first.publicKey))
    const onDisk = await readFile()
    expect(onDisk.secretKey).toBeUndefined()
    expect(onDisk.secretKeyEnc).toBeTypeOf('string')
  })

  it('regenerates and overwrites when the stored file is corrupt', async () => {
    const first = await loadOrCreatePeerKeyPair()
    await fs.writeFile(peerPath(), '{"publicKey":"zzz","secretKey":"@@@"}', 'utf-8')
    restart()
    const second = await loadOrCreatePeerKeyPair()
    expect(second.publicKey).toHaveLength(32)
    expect(publicKeyToB64(second.publicKey)).not.toBe(publicKeyToB64(first.publicKey))
    // The fresh identity is persisted, so it is itself stable from here on.
    restart()
    const third = await loadOrCreatePeerKeyPair()
    expect(publicKeyToB64(third.publicKey)).toBe(publicKeyToB64(second.publicKey))
  })

  // --- keyring locked: the pinned identity must SURVIVE, not be silently replaced -------------
  describe('when the keyring is temporarily unavailable', () => {
    it('fails loudly and leaves the encrypted file untouched (identity survives)', async () => {
      encryptionAvailable = true
      const original = await loadOrCreatePeerKeyPair()
      const before = await fs.readFile(peerPath(), 'utf-8')

      // Next boot: the app starts before gnome-keyring/kwallet is unlocked.
      encryptionAvailable = false
      restart()
      await expect(loadOrCreatePeerKeyPair()).rejects.toBeInstanceOf(PeerKeyLockedError)

      // Nothing was written: the file is byte-identical and still encrypted.
      expect(await fs.readFile(peerPath(), 'utf-8')).toBe(before)
      expect((await readFile()).secretKeyEnc).toBeTypeOf('string')
      expect((await readFile()).secretKey).toBeUndefined()

      // Once the keyring is unlocked, the SAME pinned identity comes back.
      encryptionAvailable = true
      restart()
      const after = await loadOrCreatePeerKeyPair()
      expect(publicKeyToB64(after.publicKey)).toBe(publicKeyToB64(original.publicKey))
      expect(Buffer.from(after.secretKey)).toEqual(Buffer.from(original.secretKey))
    })

    it('does not cache the failure: a later call succeeds once the keyring is back', async () => {
      encryptionAvailable = true
      const original = await loadOrCreatePeerKeyPair()
      encryptionAvailable = false
      restart()
      await expect(loadOrCreatePeerKeyPair()).rejects.toThrow(/keyring/i)
      // No restart() here: the user unlocks the keyring and reconnects in the SAME app run.
      encryptionAvailable = true
      const again = await loadOrCreatePeerKeyPair()
      expect(publicKeyToB64(again.publicKey)).toBe(publicKeyToB64(original.publicKey))
    })
  })

  // --- concurrency: two connects racing on the very first run --------------------------------
  it('two concurrent calls return the SAME keypair and write the file ONCE', async () => {
    const write = vi.spyOn(fs, 'writeFile')
    const [a, b] = await Promise.all([loadOrCreatePeerKeyPair(), loadOrCreatePeerKeyPair()])
    expect(publicKeyToB64(a.publicKey)).toBe(publicKeyToB64(b.publicKey))
    expect(Buffer.from(a.secretKey)).toEqual(Buffer.from(b.secretKey))
    expect(write).toHaveBeenCalledTimes(1)
    // ...and the key that is on disk is the one BOTH callers hold (no silent loser).
    expect((await readFile()).publicKey).toBe(publicKeyToB64(a.publicKey))
  })

  it('reuses the in-process key without re-reading the file on every call', async () => {
    await loadOrCreatePeerKeyPair()
    const read = vi.spyOn(fs, 'readFile')
    await loadOrCreatePeerKeyPair()
    expect(read).not.toHaveBeenCalled()
  })

  // --- the 0600 mode is enforced on EVERY write, not only at create ---------------------------
  it('tightens a pre-existing 0644 file to 0600 when migrating it', async () => {
    await loadOrCreatePeerKeyPair() // plaintext file
    await fs.chmod(peerPath(), 0o644) // e.g. recreated by a backup/restore tool
    encryptionAvailable = true // triggers the in-place migration write
    restart()
    await loadOrCreatePeerKeyPair()
    expect((await fs.stat(peerPath())).mode & 0o777).toBe(0o600)
  })

  it('tightens a pre-existing 0644 file to 0600 when regenerating over it', async () => {
    await fs.writeFile(peerPath(), 'garbage', { encoding: 'utf-8', mode: 0o644 })
    await fs.chmod(peerPath(), 0o644)
    await loadOrCreatePeerKeyPair()
    expect((await fs.stat(peerPath())).mode & 0o777).toBe(0o600)
  })
})
