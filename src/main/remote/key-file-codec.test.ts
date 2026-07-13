import { describe, it, expect } from 'vitest'
import {
  encodeKeyFile,
  decodeKeyFile,
  type KeyFileDecoded,
  type SafeStorageLike
} from './key-file-codec'
import { genKeyPair, publicKeyToB64, type KeyPair } from './e2ee'

// A reversible fake keychain: "encryption" is a byte-flip so we can prove the plaintext secret is
// NOT stored verbatim, yet decode round-trips. isEncryptionAvailable is toggled per test.
function fakeSafe(available: boolean): SafeStorageLike {
  const flip = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0xff))
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => flip(Buffer.from(s, 'utf-8')),
    decryptString: (b) => flip(b).toString('utf-8')
  }
}

// Narrow the three-way result to the usable one. The union is deliberately NOT `T | null`, so a
// caller cannot reach `.keys` without first ruling out 'locked' — that is the whole point.
function usable(decoded: KeyFileDecoded): { keys: KeyPair; migrate: boolean } {
  if (!decoded || decoded === 'locked') throw new Error(`expected a usable key file, got ${decoded}`)
  return decoded
}

describe('key-file-codec', () => {
  it('round-trips an encrypted key file and never stores the raw secret', () => {
    const safe = fakeSafe(true)
    const keys = genKeyPair()
    const raw = encodeKeyFile(keys, safe)
    const parsed = JSON.parse(raw) as Record<string, string>
    expect(parsed.publicKey).toBe(publicKeyToB64(keys.publicKey))
    expect(parsed.secretKeyEnc).toBeTypeOf('string')
    expect(parsed.secretKey).toBeUndefined() // secret is not on disk in the clear
    const back = usable(decodeKeyFile(raw, safe))
    expect(Buffer.from(back.keys.secretKey).toString('hex')).toBe(
      Buffer.from(keys.secretKey).toString('hex')
    )
    expect(back.migrate).toBe(false)
  })

  it('writes plaintext when encryption is unavailable and reads it back', () => {
    const safe = fakeSafe(false)
    const keys = genKeyPair()
    const raw = encodeKeyFile(keys, safe)
    const parsed = JSON.parse(raw) as Record<string, string>
    expect(parsed.secretKey).toBeTypeOf('string')
    expect(parsed.secretKeyEnc).toBeUndefined()
    const back = usable(decodeKeyFile(raw, safe))
    expect(Buffer.from(back.keys.publicKey).toString('hex')).toBe(
      Buffer.from(keys.publicKey).toString('hex')
    )
    expect(back.migrate).toBe(false)
  })

  it('flags legacy plaintext for migration when encryption becomes available (same identity)', () => {
    const keys = genKeyPair()
    const legacy = encodeKeyFile(keys, fakeSafe(false)) // written on a machine with no keyring
    const back = usable(decodeKeyFile(legacy, fakeSafe(true))) // now a keyring exists
    expect(back.migrate).toBe(true)
    expect(back.keys.secretKey).toEqual(keys.secretKey) // identity preserved, never regenerated
  })

  // --- the 'locked' outcome: encrypted file, keyring temporarily gone ------------------------
  // This is NOT corruption. The bytes are fine; only the OS keyring is unavailable right now
  // (gnome-keyring not yet unlocked, no session bus). Returning null here would make the caller
  // regenerate and DESTROY a pinned identity, so the codec reports a distinct third outcome.

  it("reports 'locked' for an encrypted file when encryption is currently unavailable", () => {
    const enc = encodeKeyFile(genKeyPair(), fakeSafe(true))
    expect(decodeKeyFile(enc, fakeSafe(false))).toBe('locked')
  })

  it("reports 'locked' even when a stale legacy plaintext secret is also present", () => {
    // A half-migrated file: the encrypted secret is authoritative and the plaintext one may be
    // stale, so with no keyring we must still refuse rather than fall back or regenerate.
    const raw = JSON.stringify({
      publicKey: Buffer.alloc(32, 7).toString('base64'),
      secretKey: Buffer.alloc(32, 7).toString('base64'),
      secretKeyEnc: Buffer.from('whatever').toString('base64')
    })
    expect(decodeKeyFile(raw, fakeSafe(false))).toBe('locked')
  })

  it("does NOT report 'locked' for a plain corrupt file (regenerating is correct there)", () => {
    const safe = fakeSafe(false)
    const pub = Buffer.alloc(32, 7).toString('base64')
    expect(decodeKeyFile('not json', safe)).toBeNull()
    expect(decodeKeyFile(JSON.stringify({ publicKey: pub }), safe)).toBeNull() // no secret at all
  })

  it('returns null on malformed JSON, missing fields, and an undecryptable blob', () => {
    const safe = fakeSafe(true)
    expect(decodeKeyFile('not json', safe)).toBeNull()
    expect(decodeKeyFile(JSON.stringify({ publicKey: 'x' }), safe)).toBeNull()
    const throwing: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => {
        throw new Error('keychain reset')
      }
    }
    const enc = encodeKeyFile(genKeyPair(), safe)
    expect(decodeKeyFile(enc, throwing)).toBeNull()
  })

  // --- negative half: a corrupt file must NEVER decode to an accepted identity ---------------
  // The caller treats null as "regenerate a fresh identity", so every malformed input below has to
  // return null (and never throw) — an accepted-but-wrong keypair would surface much later as a
  // tweetnacl "bad key size" throw deep inside the transport.

  const b64 = (bytes: number) => Buffer.alloc(bytes, 7).toString('base64')

  it('returns null on non-object JSON literals (including the `null` literal)', () => {
    const safe = fakeSafe(false)
    for (const raw of ['null', '[]', '123', '"str"', 'true', '']) {
      expect(decodeKeyFile(raw, safe), `input: ${JSON.stringify(raw)}`).toBeNull()
    }
  })

  it('returns null on a wrong-length public key (short or long)', () => {
    const safe = fakeSafe(false)
    const secretKey = b64(32)
    expect(decodeKeyFile(JSON.stringify({ publicKey: b64(16), secretKey }), safe)).toBeNull()
    expect(decodeKeyFile(JSON.stringify({ publicKey: b64(64), secretKey }), safe)).toBeNull()
  })

  it('returns null on a wrong-length secret key (short or long)', () => {
    const safe = fakeSafe(false)
    const publicKey = b64(32)
    expect(decodeKeyFile(JSON.stringify({ publicKey, secretKey: b64(15) }), safe)).toBeNull()
    expect(decodeKeyFile(JSON.stringify({ publicKey, secretKey: b64(48) }), safe)).toBeNull()
  })

  it('returns null on truncated / non-base64 garbage instead of accepting empty keys', () => {
    const safe = fakeSafe(false)
    // `Buffer.from(x, 'base64')` is lenient: it drops non-alphabet chars and truncates.
    const garbage = ['x', 'y', '!!!!', '@@@ not base64 @@@', b64(32).slice(0, 10)]
    for (const bad of garbage) {
      expect(decodeKeyFile(JSON.stringify({ publicKey: bad, secretKey: b64(32) }), safe)).toBeNull()
      expect(decodeKeyFile(JSON.stringify({ publicKey: b64(32), secretKey: bad }), safe)).toBeNull()
    }
    expect(decodeKeyFile('{"publicKey":"x","secretKey":"y"}', safe)).toBeNull()
  })

  it('returns null when the keychain decrypts to junk instead of throwing', () => {
    // We cannot verify what real Electron safeStorage does on a keychain reset (throw vs. garbage),
    // so the codec must be robust to BOTH.
    const junk = (out: string): SafeStorageLike => ({
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s, 'utf-8'),
      decryptString: () => out
    })
    const enc = encodeKeyFile(genKeyPair(), fakeSafe(true))
    expect(decodeKeyFile(enc, junk('garbage not base64'))).toBeNull()
    expect(decodeKeyFile(enc, junk(''))).toBeNull()
    expect(decodeKeyFile(enc, junk(b64(15)))).toBeNull() // right shape, wrong length
  })
})
