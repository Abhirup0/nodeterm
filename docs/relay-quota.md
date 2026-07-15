# Relay quota — backend contract (free tier)

Client behavior shipped in this repo; the API must add:

- `POST /v1/relay/host-token` — accept `{ deviceId, hostPublicKeyB64 }` (no `entitlement`)
  for free-tier hosts. Server enforces its own free-tier policy; non-OK ⇒ client keeps
  hosting down (pre-feature behavior).
- `POST /v1/relay/device` — accept `{ deviceId, hostDeviceId, hostPublicKeyB64, label }`
  (no `entitlement`) for free-tier provisioning. Non-OK ⇒ pairing degrades to LAN-only.

The client-side monthly meter (5 × peer×day) is advisory UX; the server should rate-limit
free-tier hosts independently — a patched client can skip the local meter.

## Client shape (as implemented)

- Pro sends the entitlement token unchanged (`{ entitlement, hostPublicKeyB64 }` /
  `{ entitlement, hostPublicKeyB64, label, deviceId }`); only the free tier falls back to the
  `deviceId` bodies above. See `mintHostToken` (`src/main/remote/standing-host.ts`) and the
  device mint in `src/main/pairing-service.ts`.
- The local meter lives in `src/core/relay-quota.ts` (`RELAY_QUOTA_LIMIT = 5`, keyed by
  `(peerKey, local-day)`, month anchored to `max(now, lastSeen)`), consumed at the standing
  host's `onPeerReady`: 1st use of the month silent, 2nd+ an OS notification, the 6th refused
  **before** approval so an exhausted host never serves a new pair. `isPremium()` bypasses.
