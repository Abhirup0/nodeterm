// Peer revocation for the relay trust layer.
//
// THE CRITICAL PROPERTY: unpinning a peer's key is NOT enough. Unpinning only refuses the NEXT
// handshake; the currently-open relay socket keeps full shell access (an interactive shell, files,
// canvas) until it drops on its own — i.e. "the person I just removed is still sitting in my
// terminal, typing". So revocation MUST also cut the live session. Anyone tempted to "simplify" this
// module into a pin-store delete would silently reintroduce exactly that hole.
//
// 4d ships the pure unpin + the hook contract; 4c implements the teardown body:
//     onRevoke(peerId) = close the peer's relay connection
//                      → PtyManager.dropClient(clientId)   (drop its pty subscriptions)
//                      → presenceHub.leave(clientId)       (remove it from the facepile)
// which is the same teardown `peer-registry.ts` runs when a peer sink unregisters.
//
// (peerId is the peer's stable box public key, base64 — the same identity the pin store and 4c's
// live-session registry key on.)
import { unpinDevice, type ApprovedDevices } from './approved-devices-core'

/** Pure: return a store with the peer's pin removed. Idempotent. */
export function revoke(store: ApprovedDevices, peerKeyB64: string): ApprovedDevices {
  return unpinDevice(store, peerKeyB64)
}

/** 4c implements this to KILL the live session (see file header). */
export type OnRevoke = (peerId: string) => void

export interface RevocationDeps {
  load(): Promise<ApprovedDevices>
  save(store: ApprovedDevices): Promise<void>
  onRevoke: OnRevoke
}

/**
 * Build the revoke controller. `revoke(peerKeyB64)` unpins the device on disk FIRST (so a crash
 * between the two steps, or a reconnect racing the teardown, still leaves the peer refused by the
 * pin check), THEN fires `onRevoke` to cut the open socket. The kill hook fires even when the key
 * was not pinned — a live, never-pinned session must still be killable — and even when the disk
 * write failed: a persistence error must never leave a revoked peer connected.
 */
export function createRevoker(deps: RevocationDeps): { revoke(peerKeyB64: string): Promise<void> } {
  return {
    async revoke(peerKeyB64) {
      try {
        const store = await deps.load()
        await deps.save(revoke(store, peerKeyB64))
      } catch {
        // Non-fatal for the KILL: fall through to onRevoke regardless. (Worst case the pin survives
        // a crash and the operator must revoke again — but the peer is off the wire either way.)
      }
      deps.onRevoke(peerKeyB64)
    }
  }
}
