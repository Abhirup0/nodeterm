import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { hostIdFromPublicKey, hostIdFromPublicKeyB64 } from './relay-id'
import { genKeyPair, publicKeyToB64 } from './e2ee'

describe('relay-id', () => {
  it('derives base64url(sha256(pub)).slice(0,22), no padding', () => {
    const pub = new Uint8Array(32).fill(7)
    const expected = createHash('sha256').update(pub).digest('base64url').slice(0, 22)
    const id = hostIdFromPublicKey(pub)
    expect(id).toBe(expected)
    expect(id).toHaveLength(22)
    // base64url alphabet only (no +, /, or = padding).
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('is stable and matches the b64 variant against publicKeyToB64', () => {
    const keys = genKeyPair()
    const b64 = publicKeyToB64(keys.publicKey)
    expect(hostIdFromPublicKeyB64(b64)).toBe(hostIdFromPublicKey(keys.publicKey))
  })

  it('is deterministic for a known vector (guards against a hashing/encoding drift)', () => {
    // 32 zero bytes → sha256 is a fixed, well-known digest.
    const zero = new Uint8Array(32)
    const full = createHash('sha256').update(zero).digest('base64url')
    expect(hostIdFromPublicKey(zero)).toBe(full.slice(0, 22))
  })

  it('different keys yield different ids', () => {
    expect(hostIdFromPublicKey(new Uint8Array(32).fill(1))).not.toBe(
      hostIdFromPublicKey(new Uint8Array(32).fill(2))
    )
  })
})
