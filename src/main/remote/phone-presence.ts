// One bridged relay peer's slot in the presence table (docs/team-presence.md).
//
// Both relay hosts — the interactive one (host-service.ts `initRemoteHost`) and the standing one
// (standing-host.ts) — bridge a phone over the relay, and a bridged phone is a peer: it shows up in
// the facepile and on node chips. It has no mouse, so it stays CURSORLESS (the hub joins every peer
// with `cursor: null`; nothing here ever fabricates one).
//
// The bookkeeping both hosts need is identical and easy to get wrong, so it lives here once:
//   - join() is idempotent — a listener that bridges is joined once, whatever re-fires onReady;
//   - leave() is EXACTLY-ONCE — the session-end paths are genuinely plural, because an INTENTIONAL
//     `session.close()` (device rejected, host stopped/restarted, idle-token refresh, Pro lapsed) is
//     final in relay-socket and deliberately does NOT fire `onClose`, while a socket that drops on
//     its own only fires `onClose`. Both must reach the hub, and a peer must never leave twice
//     (that would free its color for someone else while it is still on screen).
// Nulling the id after the first leave is what makes the second call a no-op.

import { allocateRelayClientId, presenceHub } from '../../core/presence/hub'
import type { ClientId } from '../../shared/presence'

export interface PhonePresence {
  /** The phone bridged → it is a peer now. Idempotent. */
  join(): void
  /** This session ended (any path) → drop the peer. Exactly-once. */
  leave(): void
  /** Its ClientId while joined, else null. */
  id(): ClientId | null
}

/** A presence slot for one bridged relay session. Join on bridge, leave on EVERY end path. */
export function createPhonePresence(): PhonePresence {
  let clientId: ClientId | null = null
  return {
    join() {
      if (clientId !== null) return
      clientId = allocateRelayClientId()
      presenceHub.join(clientId, 'phone')
    },
    leave() {
      if (clientId === null) return
      presenceHub.leave(clientId)
      clientId = null
    },
    id: () => clientId
  }
}
