import { describe, it, expect } from 'vitest'
import { genKeyPair, deriveSharedKey, encrypt, decrypt } from '../../src/main/remote/e2ee'
import { publicKeyToB64 } from '../../src/main/remote/e2ee'

describe('e2ee', () => {
  it('two keypairs derive the same shared key', () => {
    const a = genKeyPair()
    const b = genKeyPair()
    const aShared = deriveSharedKey(publicKeyToB64(b.publicKey), a.secretKey)
    const bShared = deriveSharedKey(publicKeyToB64(a.publicKey), b.secretKey)
    expect(Buffer.from(aShared).toString('hex')).toEqual(Buffer.from(bShared).toString('hex'))
  })

  it('decrypt(encrypt(m)) === m', () => {
    const a = genKeyPair()
    const b = genKeyPair()
    const shared = deriveSharedKey(publicKeyToB64(b.publicKey), a.secretKey)
    const msg = new TextEncoder().encode('hello, remote world 🌍')
    const box = encrypt(msg, shared)
    const out = decrypt(box, shared)
    expect(out).not.toBeNull()
    expect(Buffer.from(out!).toString('utf8')).toEqual('hello, remote world 🌍')
  })

  it('decrypt(tampered) === null', () => {
    const a = genKeyPair()
    const b = genKeyPair()
    const shared = deriveSharedKey(publicKeyToB64(b.publicKey), a.secretKey)
    const box = encrypt(new TextEncoder().encode('secret'), shared)
    // Flip a byte in the ciphertext/MAC region.
    const tampered = box.slice()
    tampered[tampered.length - 1] ^= 0xff
    expect(decrypt(tampered, shared)).toBeNull()
  })

  it('decrypt of too-short input === null', () => {
    const a = genKeyPair()
    const shared = deriveSharedKey(publicKeyToB64(a.publicKey), a.secretKey)
    expect(decrypt(new Uint8Array(3), shared)).toBeNull()
  })
})
