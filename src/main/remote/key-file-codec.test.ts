import { describe, it, expect } from 'vitest'
import { encodeKeyFile, decodeKeyFile, type SafeStorageLike } from './key-file-codec'
import { genKeyPair, publicKeyToB64 } from './e2ee'

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

describe('key-file-codec', () => {
  it('round-trips an encrypted key file and never stores the raw secret', () => {
    const safe = fakeSafe(true)
    const keys = genKeyPair()
    const raw = encodeKeyFile(keys, safe)
    const parsed = JSON.parse(raw) as Record<string, string>
    expect(parsed.publicKey).toBe(publicKeyToB64(keys.publicKey))
    expect(parsed.secretKeyEnc).toBeTypeOf('string')
    expect(parsed.secretKey).toBeUndefined() // secret is not on disk in the clear
    const back = decodeKeyFile(raw, safe)
    expect(back).not.toBeNull()
    expect(Buffer.from(back!.keys.secretKey).toString('hex')).toBe(
      Buffer.from(keys.secretKey).toString('hex')
    )
    expect(back!.migrate).toBe(false)
  })

  it('writes plaintext when encryption is unavailable and reads it back', () => {
    const safe = fakeSafe(false)
    const keys = genKeyPair()
    const raw = encodeKeyFile(keys, safe)
    const parsed = JSON.parse(raw) as Record<string, string>
    expect(parsed.secretKey).toBeTypeOf('string')
    expect(parsed.secretKeyEnc).toBeUndefined()
    const back = decodeKeyFile(raw, safe)
    expect(Buffer.from(back!.keys.publicKey).toString('hex')).toBe(
      Buffer.from(keys.publicKey).toString('hex')
    )
    expect(back!.migrate).toBe(false)
  })

  it('flags legacy plaintext for migration when encryption becomes available (same identity)', () => {
    const keys = genKeyPair()
    const legacy = encodeKeyFile(keys, fakeSafe(false)) // written on a machine with no keyring
    const back = decodeKeyFile(legacy, fakeSafe(true)) // now a keyring exists
    expect(back).not.toBeNull()
    expect(back!.migrate).toBe(true)
    expect(back!.keys.secretKey).toEqual(keys.secretKey) // identity preserved, never regenerated
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
