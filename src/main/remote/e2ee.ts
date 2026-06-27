// End-to-end encryption primitives for the relay transport.
//
// Pure functions over NaCl box (Curve25519 + XSalsa20-Poly1305): no sockets, no
// Electron. The box format is `nonce ‖ ciphertext ‖ mac` so an interoperable peer
// can be implemented against the same wire format.
import nacl from 'tweetnacl'

export type KeyPair = {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

export function genKeyPair(): KeyPair {
  return nacl.box.keyPair()
}

export function publicKeyToB64(key: Uint8Array): string {
  return Buffer.from(key).toString('base64')
}

export function publicKeyFromB64(b64: string): Uint8Array {
  const key = Uint8Array.from(Buffer.from(b64, 'base64'))
  if (key.length !== nacl.box.publicKeyLength) {
    throw new Error(`Invalid public key: expected ${nacl.box.publicKeyLength} bytes, got ${key.length}`)
  }
  return key
}

// Derive the shared secret (ECDH precompute) from the peer's base64 public key
// and our secret key. Both sides arrive at the same value.
export function deriveSharedKey(theirPubB64: string, ourSecret: Uint8Array): Uint8Array {
  const theirPub = publicKeyFromB64(theirPubB64)
  return nacl.box.before(theirPub, ourSecret)
}

// Encrypt with the precomputed shared key. Returns `nonce ‖ ciphertext ‖ mac`.
export function encrypt(plain: Uint8Array, shared: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const ciphertext = nacl.box.after(plain, nonce, shared)

  const box = new Uint8Array(nonce.length + ciphertext.length)
  box.set(nonce)
  box.set(ciphertext, nonce.length)
  return box
}

// Short Authentication String: a 6-digit code derived from the ECDH shared key. Both peers
// compute the SAME value (same shared key), so the two humans can compare it out-of-band to
// confirm they're on the same channel before the host approves a connection. Formatted "NNN NNN".
export function sasFromSharedKey(shared: Uint8Array): string {
  const h = nacl.hash(shared) // SHA-512
  // Fold the first 4 bytes into a 32-bit int, then take 6 decimal digits.
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0
  const code = (n % 1_000_000).toString().padStart(6, '0')
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

// Decrypt a `nonce ‖ ciphertext ‖ mac` box. Returns null on malformed input or
// a failed MAC check — never throws.
export function decrypt(box: Uint8Array, shared: Uint8Array): Uint8Array | null {
  if (box.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    return null
  }
  const nonce = box.slice(0, nacl.box.nonceLength)
  const ciphertext = box.slice(nacl.box.nonceLength)
  const plain = nacl.box.open.after(ciphertext, nonce, shared)
  return plain ?? null
}
