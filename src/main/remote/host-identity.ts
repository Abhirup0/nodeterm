// Persistent HOST identity for the relay transport.
//
// The host's box public key IS its identity: it hashes to the hostId a peer dials, and every peer
// that pairs with this desktop PINS it. Rotating it is not a recoverable blip — every pinned peer
// must re-approve and the old key is gone for good.
//
// This is the same shape as peer-identity.ts (its reference implementation), against its OWN file
// `remote-host-key.json`, and the on-disk bytes are unchanged from the format host-service.ts used
// to inline: public key plaintext base64 (it is a pinned identity, not a secret), secret key either
// safeStorage-encrypted (`secretKeyEnc`) or 0600 plaintext (`secretKey`), migrated in place once a
// keyring appears.
//
// So we write on exactly three paths — first run, in-place migration, a genuinely unusable file —
// and NEVER on a file we merely cannot read RIGHT NOW (keyring locked, no session bus). That case
// fails loudly with HostKeyLockedError: the identity on disk is intact and must stay that way.
// The old inline loader got this wrong — it read `secretKeyEnc` only when
// `safeStorage.isEncryptionAvailable()`, so a boot before gnome-keyring/kwallet unlocked fell
// through to `genKeyPair()` and overwrote the good encrypted key with a fresh plaintext one.
import { promises as fs } from 'fs'
import path from 'path'
import { app, safeStorage } from 'electron'
import { genKeyPair, type KeyPair } from './e2ee'
import { encodeKeyFile, decodeKeyFile } from './key-file-codec'

/**
 * The stored host identity is encrypted and the OS keyring is unavailable right now (locked
 * gnome-keyring/kwallet, no session bus). The key is intact on disk and we refuse to overwrite it.
 * Hosting cannot start until it can be read: surface this to the user — unlock the keyring and
 * start hosting again.
 */
export class HostKeyLockedError extends Error {
  readonly code = 'E_HOST_KEY_LOCKED'
  constructor() {
    super(
      'This computer’s host identity is encrypted, but the OS keyring is locked or unavailable. ' +
        'Unlock it and start remote access again — the key is intact and will not be replaced.'
    )
    this.name = 'HostKeyLockedError'
  }
}

function keyFile(): string {
  return path.join(app.getPath('userData'), 'remote-host-key.json')
}

async function persistKeyPair(file: string, keys: KeyPair): Promise<void> {
  // `mode` in writeFile only applies when the file is CREATED — an existing file (migration,
  // regeneration, or one a backup tool restored 0644) keeps its old mode. So chmod on every write.
  await fs.writeFile(file, encodeKeyFile(keys, safeStorage), { encoding: 'utf-8', mode: 0o600 })
  await fs.chmod(file, 0o600)
}

async function readKeyFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch (err) {
    // ENOENT is the only "no identity yet" case. Any other read failure (EACCES, EIO) means a file
    // may well be there and simply unreadable — regenerating over it would destroy the identity.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null
    throw err
  }
}

async function loadOrCreate(file: string): Promise<KeyPair> {
  const raw = await readKeyFile(file)
  if (raw !== null) {
    const decoded = decodeKeyFile(raw, safeStorage)
    if (decoded === 'locked') throw new HostKeyLockedError() // intact identity: do NOT write
    if (decoded) {
      if (decoded.migrate) await persistKeyPair(file, decoded.keys).catch(() => {})
      return decoded.keys
    }
    // decoded === null → malformed or undecryptable for good; a fresh identity is the only option.
  }
  const keys = genKeyPair()
  await persistKeyPair(file, keys).catch(() => {})
  return keys
}

// One identity per app run. Without this, the interactive host and the standing host racing on the
// very FIRST run each generate a key and each write: last write wins and the loser advertises a
// public key that is not on disk — a peer that pins it pins an identity that never comes back.
// Caching the promise also drops a disk read per connect. Failures are NOT cached: unlock the
// keyring and the next call retries.
let inflight: Promise<KeyPair> | null = null
let inflightFile: string | null = null

/**
 * Load the long-lived host keypair, generating + persisting it on first use. Its public key is
 * pinned by every paired peer, so it must be stable across runs.
 *
 * @throws HostKeyLockedError when an encrypted key exists but the keyring is currently unavailable.
 */
export function loadOrCreateHostKeyPair(): Promise<KeyPair> {
  const file = keyFile()
  if (inflight && inflightFile === file) return inflight
  const pending = loadOrCreate(file)
  inflight = pending
  inflightFile = file
  pending.catch(() => {
    if (inflight === pending) {
      inflight = null
      inflightFile = null
    }
  })
  return pending
}

/** Test seam: drop the in-process cache, i.e. simulate an app restart. */
export function resetHostKeyCache(): void {
  inflight = null
  inflightFile = null
}
