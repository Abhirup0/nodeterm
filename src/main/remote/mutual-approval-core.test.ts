import { describe, it, expect } from 'vitest'
import {
  emptyMutualApproval,
  confirmLocal,
  confirmRemote,
  isMutuallyApproved,
  mutualSas,
  recordApproval
} from './mutual-approval-core'
import { genKeyPair, deriveSharedKey, publicKeyToB64 } from './e2ee'
import { isPinned } from './approved-devices-core'

describe('mutual SAS agreement', () => {
  it('both ends derive the SAME 6-digit code from their shared key', () => {
    const host = genKeyPair()
    const client = genKeyPair()
    const hostShared = deriveSharedKey(publicKeyToB64(client.publicKey), host.secretKey)
    const clientShared = deriveSharedKey(publicKeyToB64(host.publicKey), client.secretKey)
    const a = mutualSas(hostShared)
    const b = mutualSas(clientShared)
    expect(a).toBe(b)
    expect(a).toMatch(/^\d{3} \d{3}$/)
  })

  it('a man-in-the-middle (different shared key) shows a DIFFERENT code', () => {
    const host = genKeyPair()
    const client = genKeyPair()
    const mitm = genKeyPair()
    // Host actually talks to the MITM; the client actually talks to the MITM too.
    const hostShared = deriveSharedKey(publicKeyToB64(mitm.publicKey), host.secretKey)
    const clientShared = deriveSharedKey(publicKeyToB64(mitm.publicKey), client.secretKey)
    // The two humans read out different digits -> they refuse to confirm.
    expect(mutualSas(hostShared)).not.toBe(mutualSas(clientShared))
  })
})

describe('both ends must confirm', () => {
  it('is not approved until BOTH local and remote confirm', () => {
    let s = emptyMutualApproval()
    expect(isMutuallyApproved(s)).toBe(false)
    s = confirmLocal(s)
    expect(isMutuallyApproved(s)).toBe(false) // only I confirmed
    s = confirmRemote(s)
    expect(isMutuallyApproved(s)).toBe(true) // now both
  })

  it('order does not matter (remote-first)', () => {
    let s = confirmRemote(emptyMutualApproval())
    expect(isMutuallyApproved(s)).toBe(false)
    s = confirmLocal(s)
    expect(isMutuallyApproved(s)).toBe(true)
  })

  it('confirming the SAME side twice never approves (no self-satisfying handshake)', () => {
    const localTwice = confirmLocal(confirmLocal(emptyMutualApproval()))
    expect(isMutuallyApproved(localTwice)).toBe(false)
    const remoteTwice = confirmRemote(confirmRemote(emptyMutualApproval()))
    expect(isMutuallyApproved(remoteTwice)).toBe(false)
  })
})

describe('pin-both-ends', () => {
  it('recordApproval pins the peer key only once mutually approved', () => {
    const half = confirmLocal(emptyMutualApproval())
    const notYet = recordApproval({ pubkeys: [] }, 'peerKey', half)
    expect(isPinned(notYet, 'peerKey')).toBe(false) // half-confirmed → no pin

    const full = confirmRemote(half)
    const pinned = recordApproval({ pubkeys: [] }, 'peerKey', full)
    expect(isPinned(pinned, 'peerKey')).toBe(true)
  })

  it('both ends end up pinning the OTHER (symmetric)', () => {
    const hostPub = 'HOST_PUB'
    const clientPub = 'CLIENT_PUB'
    const done = confirmRemote(confirmLocal(emptyMutualApproval()))
    // Host pins the client; client pins the host — each against its own store.
    const hostStore = recordApproval({ pubkeys: [] }, clientPub, done)
    const clientStore = recordApproval({ pubkeys: [] }, hostPub, done)
    expect(isPinned(hostStore, clientPub)).toBe(true)
    expect(isPinned(clientStore, hostPub)).toBe(true)
  })
})
