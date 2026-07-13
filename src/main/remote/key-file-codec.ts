// Pure encode/decode for a persisted NaCl box keypair file, with encrypt-at-rest and a legacy
// plaintext fallback + in-place migration. The Electron `safeStorage` is injected as `SafeStorageLike`
// so this stays free of `electron` and unit-tests without a keychain. The on-disk byte format mirrors
// host-service.ts's persistKeyPair/loadOrCreateKeyPair exactly (public key always plaintext base64 —
// it is a pinned identity, not a secret — the secret key either safeStorage-encrypted or 0600 plaintext).
//
// NOTE (intentional duplication): host-service.ts still inlines the same format. We do NOT refactor it
// to use this codec — that file is Stage 4c's to rewrite, and editing it here would collide. 4c may
// adopt this codec when it rewrites the handshake.
import type { KeyPair } from './e2ee'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(ciphertext: Buffer): string
}

interface KeyFileBody {
  publicKey?: string
  secretKey?: string // legacy plaintext base64
  secretKeyEnc?: string // safeStorage ciphertext, base64
}

/** Serialize a keypair to the on-disk JSON string; encrypted when safeStorage is available. */
export function encodeKeyFile(keys: KeyPair, safe: SafeStorageLike): string {
  const publicKey = Buffer.from(keys.publicKey).toString('base64')
  const secretB64 = Buffer.from(keys.secretKey).toString('base64')
  const body: KeyFileBody = safe.isEncryptionAvailable()
    ? { publicKey, secretKeyEnc: safe.encryptString(secretB64).toString('base64') }
    : { publicKey, secretKey: secretB64 }
  return JSON.stringify(body)
}

/**
 * Parse a key file. Returns the keypair plus `migrate:true` when the file is legacy plaintext but
 * encryption is now available (caller should re-persist to upgrade in place, KEEPING the identity).
 * Returns null on malformed input or an undecryptable blob (e.g. keychain reset) — the caller then
 * generates a fresh identity, exactly as host-service.ts does.
 */
export function decodeKeyFile(
  raw: string,
  safe: SafeStorageLike
): { keys: KeyPair; migrate: boolean } | null {
  let body: KeyFileBody
  try {
    body = JSON.parse(raw) as KeyFileBody
  } catch {
    return null
  }
  if (!body.publicKey) return null
  const publicKey = Uint8Array.from(Buffer.from(body.publicKey, 'base64'))
  if (body.secretKeyEnc && safe.isEncryptionAvailable()) {
    try {
      const secretB64 = safe.decryptString(Buffer.from(body.secretKeyEnc, 'base64'))
      return {
        keys: { publicKey, secretKey: Uint8Array.from(Buffer.from(secretB64, 'base64')) },
        migrate: false
      }
    } catch {
      return null
    }
  }
  if (body.secretKey) {
    return {
      keys: { publicKey, secretKey: Uint8Array.from(Buffer.from(body.secretKey, 'base64')) },
      // Legacy plaintext but a keyring now exists → the caller should re-persist encrypted.
      migrate: safe.isEncryptionAvailable()
    }
  }
  return null
}
