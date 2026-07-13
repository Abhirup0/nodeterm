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
})
