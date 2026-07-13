// Pure state for SYMMETRIC pairing approval: both ends verify the same 6-digit SAS out of band and
// both pin the other's key. Today approval is one-way (only the host pins the client). This adds the
// second confirmation direction + the pin-both-ends bookkeeping as pure logic — no sockets, no
// Electron — so it unit-tests directly and 4c can wire it into either end's handshake.
//
// The SAS digits themselves are already identical on both ends (both derive from the same ECDH shared
// key via sasFromSharedKey); "mutual" means BOTH humans must confirm before the session opens, and
// EACH end independently pins the other's stable box public key. A man-in-the-middle on the relay
// terminates two DIFFERENT ECDH exchanges, so the two humans read out different digits and refuse —
// which is exactly why neither confirmation alone may unlock the session.
import { sasFromSharedKey } from './e2ee'
import { pinDevice, type ApprovedDevices } from './approved-devices-core'

export interface MutualApproval {
  /** This human confirmed the SAS on THIS device. */
  localConfirmed: boolean
  /** The peer signalled (over the channel) that its human confirmed too. */
  remoteConfirmed: boolean
}

export function emptyMutualApproval(): MutualApproval {
  return { localConfirmed: false, remoteConfirmed: false }
}

export function confirmLocal(s: MutualApproval): MutualApproval {
  return s.localConfirmed ? s : { ...s, localConfirmed: true }
}

export function confirmRemote(s: MutualApproval): MutualApproval {
  return s.remoteConfirmed ? s : { ...s, remoteConfirmed: true }
}

/**
 * Approved only when BOTH ends have confirmed the SAS. There is deliberately no other way to reach
 * this state: the two confirmations live on separate fields, each set by its own one-way transition,
 * so re-playing one side's confirmation (calling confirmLocal/confirmRemote twice) can never stand in
 * for the other's.
 */
export function isMutuallyApproved(s: MutualApproval): boolean {
  return s.localConfirmed && s.remoteConfirmed
}

/** The 6-digit code ("NNN NNN") BOTH ends compute + confirm. Thin alias so 4c reads clearly. */
export function mutualSas(shared: Uint8Array): string {
  return sasFromSharedKey(shared)
}

/**
 * Pin the peer's stable box public key locally — but ONLY once the SAS is mutually confirmed, so a
 * half-finished handshake never leaves a pinned identity. Idempotent (pinDevice is). Each end calls
 * this against its OWN store with the OTHER end's key, so both ends pin.
 */
export function recordApproval(
  store: ApprovedDevices,
  peerKeyB64: string,
  s: MutualApproval
): ApprovedDevices {
  if (!isMutuallyApproved(s)) return store
  return pinDevice(store, peerKeyB64)
}
