// End-to-end envelope test for encrypted LAN pairing.
//
// Proves the exact wire contract the phone (nodeterm-ios NaClBox) and the host (pairing-service)
// implement: the phone seals the {token,publicKey,deviceId} request to the host's QR-authenticated
// public key, the host opens it, seals the response with the same shared key, and the phone opens
// that. Both sides here use src/main/remote/e2ee.ts (proven wire-compatible with tweetnacl/Sodium),
// so this locks the envelope shape and the failure mode.

import { describe, it, expect } from 'vitest'
import {
  genKeyPair,
  publicKeyToB64,
  deriveSharedKey,
  encrypt,
  decrypt
} from './remote/e2ee'

const enc = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'utf8'))
const dec = (b: Uint8Array): string => Buffer.from(b).toString('utf8')

describe('encrypted pairing envelope (host ↔ phone round-trip)', () => {
  it('phone seals the request to the host key; host opens it and seals the response back', () => {
    // Host: long-lived box keypair; its public key is what rides the QR as `hostKey`.
    const host = genKeyPair()
    const hostKeyB64 = publicKeyToB64(host.publicKey)

    // --- Phone side ---
    const eph = genKeyPair()
    const phoneShared = deriveSharedKey(hostKeyB64, eph.secretKey)
    const reqPlain = JSON.stringify({
      token: 'one-time-token',
      publicKey: 'ssh-ed25519 AAAA phone@nodeterm',
      deviceId: 'phone-device-uuid'
    })
    const reqBox = encrypt(enc(reqPlain), phoneShared)
    // Over the wire: POST { epk: base64(eph.public), box: base64(reqBox) }
    const wire = {
      epk: publicKeyToB64(eph.publicKey),
      box: Buffer.from(reqBox).toString('base64')
    }

    // --- Host side ---
    const hostShared = deriveSharedKey(wire.epk, host.secretKey)
    const openedReq = decrypt(Uint8Array.from(Buffer.from(wire.box, 'base64')), hostShared)
    expect(openedReq).not.toBeNull()
    expect(JSON.parse(dec(openedReq!))).toEqual({
      token: 'one-time-token',
      publicKey: 'ssh-ed25519 AAAA phone@nodeterm',
      deviceId: 'phone-device-uuid'
    })

    // Host seals the response with the SAME shared key.
    const respPlain = JSON.stringify({
      ok: true,
      deviceId: 'minted-device',
      agentToken: 'agent-bearer',
      relay: { hostId: 'h', hostPublicKeyB64: hostKeyB64, relayEndpoint: 'wss://relay' },
      relayDeviceToken: '90-day-secret'
    })
    const respBox = encrypt(enc(respPlain), hostShared)
    const respWire = { box: Buffer.from(respBox).toString('base64') }

    // --- Phone opens the response ---
    const openedResp = decrypt(
      Uint8Array.from(Buffer.from(respWire.box, 'base64')),
      phoneShared
    )
    expect(openedResp).not.toBeNull()
    const resp = JSON.parse(dec(openedResp!))
    expect(resp.relayDeviceToken).toBe('90-day-secret')
    expect(resp.ok).toBe(true)
  })

  it('a tampered box fails to open (MAC check)', () => {
    const host = genKeyPair()
    const eph = genKeyPair()
    const shared = deriveSharedKey(publicKeyToB64(host.publicKey), eph.secretKey)
    const box = encrypt(enc('{"token":"t"}'), deriveSharedKey(publicKeyToB64(eph.publicKey), host.secretKey))

    // Flip a byte in the ciphertext region (past the 24-byte nonce).
    const tampered = Uint8Array.from(box)
    tampered[tampered.length - 1] ^= 0xff
    expect(decrypt(tampered, shared)).toBeNull()
  })
})
