// Pure encode/decode for a persisted NaCl box keypair file, with encrypt-at-rest and a legacy
// plaintext fallback + in-place migration. The Electron `safeStorage` is injected as `SafeStorageLike`
// so this stays free of `electron` and unit-tests without a keychain. The on-disk byte format mirrors
// host-service.ts's persistKeyPair/loadOrCreateKeyPair exactly (public key always plaintext base64 —
// it is a pinned identity, not a secret — the secret key either safeStorage-encrypted or 0600 plaintext).
//
// NOTE (intentional duplication): host-service.ts still inlines the same format. We do NOT refactor it
// to use this codec — that file is Stage 4c's to rewrite, and editing it here would collide. 4c may
// adopt this codec when it rewrites the handshake.
import { publicKeyFromB64, secretKeyFromB64, type KeyPair } from './e2ee'

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
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return null
  }
  // `JSON.parse` happily yields null / arrays / numbers for a truncated or aborted write; only a
  // plain object can be a key file. (Without this, the literal `null` threw a TypeError below.)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const file = body as KeyFileBody
  if (!file.publicKey) return null

  // Both key parsers are STRICT about the 32-byte length and throw otherwise — base64 decoding is
  // lenient (drops junk chars, truncates), so a corrupt file would otherwise decode to a
  // short/empty "identity" that the caller accepts and only fails much later inside nacl.
  try {
    const publicKey = publicKeyFromB64(file.publicKey)
    if (file.secretKeyEnc && safe.isEncryptionAvailable()) {
      // decryptString may throw (keychain reset) OR return junk — either way we return null.
      const secretB64 = safe.decryptString(Buffer.from(file.secretKeyEnc, 'base64'))
      return { keys: { publicKey, secretKey: secretKeyFromB64(secretB64) }, migrate: false }
    }
    if (file.secretKey) {
      return {
        keys: { publicKey, secretKey: secretKeyFromB64(file.secretKey) },
        // Legacy plaintext but a keyring now exists → the caller should re-persist encrypted.
        migrate: safe.isEncryptionAvailable()
      }
    }
  } catch {
    return null
  }
  return null
}
