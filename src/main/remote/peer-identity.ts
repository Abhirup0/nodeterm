// Persistent CLIENT (peer) identity for the relay transport.
//
// Today the relay client mints an EPHEMERAL keypair per connection (client-service.ts:286), so it
// presents a different box public key on every reconnect and can never be pinned. This gives the
// client a long-lived NaCl box keypair — the STABLE public identity a host pins on first pair and
// recognises across reconnects. It mirrors host-service.ts's loadOrCreateKeyPair (same on-disk
// shape) but uses its OWN file, so the peer and host identities never share bytes. Encrypted at
// rest with Electron safeStorage; 0600 plaintext fallback when no keyring is available —
// availability is re-checked on every start, so a machine that gains a keyring migrates in place,
// KEEPING the identity.
//
// The key is an IDENTITY, not a session artefact: losing a connection is recoverable, losing the
// key means every host that pinned it must re-approve this peer. So we write on exactly three
// paths — first run, in-place migration, a genuinely unusable file — and never on a file we merely
// cannot read RIGHT NOW (keyring locked): that fails loudly instead. See PeerKeyLockedError.
//
// 4c wires this into client-service.ts in place of `genKeyPair()`.
import { promises as fs } from 'fs'
import path from 'path'
import { app, safeStorage } from 'electron'
import { genKeyPair, type KeyPair } from './e2ee'
import { encodeKeyFile, decodeKeyFile } from './key-file-codec'

/**
 * The stored identity is encrypted and the OS keyring is unavailable right now (locked
 * gnome-keyring/kwallet, no session bus). The key is intact on disk and we refuse to overwrite it.
 * The connection path should surface this to the user: unlock the keyring and reconnect.
 */
export class PeerKeyLockedError extends Error {
  readonly code = 'E_PEER_KEY_LOCKED'
  constructor() {
    super(
      'Your device identity is encrypted, but the OS keyring is locked or unavailable. ' +
        'Unlock it and reconnect — the key is intact and will not be replaced.'
    )
    this.name = 'PeerKeyLockedError'
  }
}

function keyFile(): string {
  return path.join(app.getPath('userData'), 'remote-peer-key.json')
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
    if (decoded === 'locked') throw new PeerKeyLockedError() // intact identity: do NOT write
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

// One identity per app run. Without this, two connects racing on the very FIRST run each generate a
// key and each write: last write wins and the loser holds a key that is not on disk — if that one
// gets pinned, the host pins an identity that never comes back. Caching the promise also drops a
// disk read per reconnect. Failures are NOT cached: unlock the keyring and the next call retries.
let inflight: Promise<KeyPair> | null = null
let inflightFile: string | null = null

/**
 * Load the long-lived client (peer) keypair, generating + persisting it on first use. The public
 * key is what a host pins, so it must be stable across reconnects and app restarts.
 *
 * @throws PeerKeyLockedError when an encrypted key exists but the keyring is currently unavailable.
 */
export function loadOrCreatePeerKeyPair(): Promise<KeyPair> {
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
export function resetPeerKeyCache(): void {
  inflight = null
  inflightFile = null
}
