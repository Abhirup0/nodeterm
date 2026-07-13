// Persistent CLIENT (peer) identity for the relay transport.
//
// Today the relay client mints an EPHEMERAL keypair per connection (client-service.ts:286), so it
// presents a different box public key on every reconnect and can never be pinned. This gives the
// client a long-lived NaCl box keypair — the STABLE public identity a host pins on first pair and
// recognises across reconnects. It mirrors host-service.ts's loadOrCreateKeyPair (same on-disk
// shape, same failure posture) but uses its OWN file, so the peer and host identities never share
// bytes. Encrypted at rest with Electron safeStorage; 0600 plaintext fallback when no keyring is
// available — availability is re-checked on every load, so a machine that gains a keyring migrates
// in place on the next start, KEEPING the identity.
//
// 4c wires this into client-service.ts in place of `genKeyPair()`.
import { promises as fs } from 'fs'
import path from 'path'
import { app, safeStorage } from 'electron'
import { genKeyPair, type KeyPair } from './e2ee'
import { encodeKeyFile, decodeKeyFile } from './key-file-codec'

function keyFile(): string {
  return path.join(app.getPath('userData'), 'remote-peer-key.json')
}

async function persistKeyPair(keys: KeyPair): Promise<void> {
  // 0o600 either way: the file still binds the pinned public identity.
  await fs.writeFile(keyFile(), encodeKeyFile(keys, safeStorage), {
    encoding: 'utf-8',
    mode: 0o600
  })
}

/**
 * Load the long-lived client (peer) keypair, generating + persisting it on first use. The public key
 * is what a host pins, so it must be stable across reconnects and app restarts. A legacy plaintext
 * file upgrades to the encrypted form in place (same identity); a malformed file or an undecryptable
 * blob (keychain reset) decodes to null and falls through to a fresh identity, which is written back
 * so it is itself stable from then on — a new pairing then pins the new key.
 */
export async function loadOrCreatePeerKeyPair(): Promise<KeyPair> {
  try {
    const decoded = decodeKeyFile(await fs.readFile(keyFile(), 'utf-8'), safeStorage)
    if (decoded) {
      if (decoded.migrate) await persistKeyPair(decoded.keys).catch(() => {})
      return decoded.keys
    }
  } catch {
    // No stored key (first run) or an unreadable file — generate a fresh one below.
  }
  const keys = genKeyPair()
  await persistKeyPair(keys).catch(() => {})
  return keys
}
