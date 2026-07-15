# Design: Team Access — multi-seat relay, device-seat + email invite

**Date:** 2026-07-15
**Branch:** `feat/team-access` (worktree `/root/nodeterm-team`, off `main`)
**Status:** approved (model + design), spec for review.

## Problem / goal

The relay/presence infrastructure (cursors, chat, co-attach, canvas sync, dino) already carries N
clients through `CorePlatform.clientIds()` — but the desktop **relay host accepts only ONE device**
(`relay-host-service.ts` keeps a single `current` listener, superseded on each `start()`), and there
is no paid packaging. Turn this into a marketable **Team Access**: the paying host shares this Mac
with up to **N teammates** (one seat per connected device), sold at **$5/seat/month**, invited by
email. This spec is the **app side** (buildable in this repo now); the backend (Stripe per-seat, the
`seats` entitlement field, email delivery) is a documented contract, a separate effort.

## Model (approved)

**Device-seat + email invite.** The paying host owns `seats`; each connected device consumes one
seat; **email is only a label + an invite convenience** (you enter a teammate's email, the app
generates a pairing code+link you share; the email tags that seat). Trust stays the **mutual SAS +
ConsentNotice** handshake — one deliberate approval per seat. No accounts, no login; identity is the
device, exactly as today. `seats` comes from the entitlement (backend); absent → **1** =
bit-for-bit today's single-peer behavior.

## Architecture (app side)

### A. Multi-peer relay host (the core change)
`relay-host-service.ts` today has one `current` session, superseded on `start()`. Change it to a
**pool** of up to `seats` live `RelayHostSession`s:
- **Invite = one pairing offer = one seat.** A new `relay:host:invite` (renderer → main) mints ONE
  fresh pairing offer (via the existing `connectRelayHost` + `mintPairingToken`) and ADDS it to the
  pool — it does NOT supersede existing peers. Returns the offer (code+link) for the renderer to
  share. Optional `{ email }` metadata tags the pending/live seat.
- **Seat cap (host-side enforcement).** Before minting an invite (and again when a peer completes
  approval), refuse if `livePeers >= seats` → an `E_SEATS_FULL` error the UI shows as "All seats in
  use — add a seat." `seats` is read from the license entitlement (below). This is UX/host
  enforcement; server-side is v2 (backend).
- **Pool lifecycle.** `byId` already maps a renderer id → session; generalize `current` → a `Set`/
  `Map` of live sessions. `onOpen` adds to the live set + emits `relay:host:open {id, email}`;
  `onClosed` removes it + emits `relay:host:closed {id}`. `stop()` closes ALL (host stops sharing).
  Per-peer teardown: `relay:host:revoke {id}` closes ONE (see D). Each session is independent — one
  peer dropping never touches another; presence/canvas-sync already fan out per client.
- **Backward compat:** `seats` absent/1 → the pool holds at most 1 → identical to today (one
  invite supersedes? no — with cap 1, a second invite is refused until the first drops). The
  existing single-peer approval/SAS/consent path per session is unchanged.

### B. Seat count from the entitlement
- `src/core/license.ts` `Payload` gains an optional `seats?: number`; `LicenseStatus` surfaces a
  resolved `seats`. **Hosting still gates on `isPremium` (unchanged)** — a free user cannot host at
  all, regardless of `seats`. For a **premium** user, `seats` is the cap; **absent → 1** (an existing
  single-device Pro token has no field yet, so it behaves exactly as today). Verified offline like
  the rest of the token — the backend signs `seats` into the Ed25519 entitlement.
- Exposed to the renderer via the existing license IPC/`LicenseApi` (a `seats` field on the status).
- The relay-host-service reads `seats` (through `CorePlatform`/a getter) to enforce the cap.

### C. Settings → "Team Access" section (the product surface)
A new `SettingsPage` section (`components/settings/sections/TeamAccessSection.tsx`):
- **Pitch + gate.** "Share this Mac with your team — $5/seat/month." Not premium → the value copy +
  an **"Get Team Access"** CTA opening the existing Stripe checkout URL (`license` checkout). Premium
  → the live panel below.
- **Seat counter:** `Used 2 / 5` (live peers / `seats`).
- **Connected devices list:** one row per live seat — the email label (if invited with one) + the
  peer's presence name/color + a **Remove** action (per-peer revoke, D). Pending (invited, not yet
  connected) rows show "waiting…".
- **Invite teammate:** an email input → **Generate invite** → shows the pairing code + a share row
  **[Copy] [Open in Mail]** (mailto: with a prefilled body). The email tags the seat.
- **Add seats CTA:** opens the Stripe checkout (seat quantity handled by Stripe; the app only opens
  the URL). Disabled/hidden if the checkout isn't configured.

### D. Per-peer revoke UI (closing the 4c follow-up)
The revoke MECHANISM (`killRelayHostsByPeerKey` / `onRevoke` → `createRevoker`, `remote:revoke-peer`)
is built + tested + cut-wired but had **no renderer trigger** (flagged in the 4c security review).
Team Access wires it: each connected-device row's **Remove** calls a new preload `relayHost.revoke(id)`
→ `relay:host:revoke` → closes that peer's live session immediately (socket torn down, presence
leave). Distinct from `stop()` (which drops all). This also revokes the pin so the device must
re-pair.

### E. Invite email label
The `{ email }` from the invite is held on the `RelayHostSession` (pending → live) and rides the
`relay:host:peer-pending`/`open` events, so the settings list shows "Ayşe (ayse@x.com)". It is a
DISPLAY label only (never trust/identity — the SAS is the gate).

## Backend contract (NOT this repo — documented follow-up)
The app expects; the backend (api.nodeterm.dev / relay) provides:
1. **`seats: N` in the entitlement token** — a Stripe per-seat subscription ($5/seat) → webhook →
   the signer includes `seats` in the Ed25519 payload. Absent → the app treats it as 1.
2. **(Optional v1.5) real email delivery** — an invite endpoint that emails the code+link. v1 has the
   app generate + the user share, so this is not blocking.
3. **(v2) server-side seat enforcement** — the relay refuses the (seats+1)th bridge per account.
   v1 enforces host-side only; that is enough because a host bypassing its own cap only cheats
   itself (it's paying). A code comment at the enforcement site should record that this is UX/host
   enforcement, not a server-guaranteed limit.

## Security
Multi-peer means up to N devices get shell access to this Mac. The trust model is unchanged and
sound: **every seat is a separate mutual-SAS + ConsentNotice approval** (Stage 4c) — inviting N
people is N deliberate grants, exactly like inviting one. No auto-admit from a pin on the desktop
path (4c: `isPinned` is phone-only). The seat cap is UX, not a security boundary. A **whole-branch
security review** is required before merge (no crypto/handshake file should change — this is
pool-management + UI + one entitlement field). Per-peer revoke must cut the LIVE socket (D), not just
unpin.

## Components / boundaries
- `src/main/remote/relay-host-service.ts` — single `current` → a pool; `relay:host:invite` (add,
  cap-checked) + `relay:host:revoke` (close one); `onOpen`/`onClosed` carry the seat id + email.
- `src/core/license.ts` — `Payload.seats?` + `LicenseStatus.seats` (default 1 / 0-when-free);
  a getter the host reads for the cap.
- `src/shared/ipc.ts` + `src/preload/index.ts` + `src/renderer/bridge/*` — `relay:host:invite`
  (invoke, returns offer), `relay:host:revoke` (send), the `seats` on license status; bridge shims.
- `src/renderer/components/settings/sections/TeamAccessSection.tsx` — the panel (pitch, counter,
  device list, invite, add-seats, per-peer revoke). Registered in `SettingsPage` nav.
- `src/renderer/state/*` — a small store for the live seats/pending list fed by the
  `relay:host:open/closed/peer-pending` events (mirrors the existing relay-host renderer wiring).
- Pure helpers (testable): the seat-cap decision (`canAcceptSeat(live, seats)`), the invite
  view-model (offer + email → share text / mailto), the seats-from-status derivation.

## Error handling / edge cases
- **Cap reached:** invite/approval refused with `E_SEATS_FULL`; the UI shows "add a seat" + the CTA.
- **Not premium:** the host `isPremium` gate (unchanged) already blocks hosting → the section shows
  the pitch + "Get Team Access" CTA, no invite/seat panel. Premium with no `seats` field → cap 1
  (today's single-peer behavior).
- **A peer drops:** its seat frees immediately (pool removes it); a pending invite for it can be
  re-issued. No ghost seat.
- **Revoke:** cuts the live socket + unpins (re-pair required). Revoking one never affects others.
- **Downgrade (seats drops below live count):** existing peers stay connected until they drop
  (we don't kick live sessions on a token refresh); NEW invites are capped at the new number. Note
  in code.
- **Solo / free user, no invites:** zero behavior change — the pool is empty, presence is silent.

## Testing
- **relay-host-service** (unit, existing harness): `invite` adds a session and returns an offer;
  a 2nd `invite` at cap → `E_SEATS_FULL`; `revoke(id)` closes only that session; `onClosed` frees the
  seat so a fresh invite succeeds; `stop()` closes all. The crypto/carrier gate passes unchanged.
- **license** (unit): `seats` parsed from a token; absent → 1; not-premium → 0/absent.
- **pure helpers** (unit): `canAcceptSeat`, the invite view-model (mailto/share text), seats-from-status.
- **settings section**: pure view-model tested (no jsdom for the panel); typecheck for JSX.
- **Manual N-instance:** host with seats≥3 invites 2 teammates (2 pairing codes), both connect (2
  SAS+consent), the settings list shows both with email labels + Used 2/3; Remove one → it drops,
  Used 1/3; a 3rd+4th invite past the cap is refused. Cursors/chat/dino from all connected peers.

## Out of scope (v1)
Stripe per-seat wiring + the `seats` signer (backend); real email delivery (app generates + user
shares); server-side seat enforcement; accounts/login; kicking live sessions on downgrade; a team
roster that persists across restarts (seats are live connections, not a stored membership).

## Merge gate
No crypto/handshake file changed (pool + UI + one entitlement field only); full suite + typecheck
green; whole-branch security review (multi-peer shell access; each seat is a separate SAS grant; the
cap is UX; revoke cuts the live socket). Then merge to main. The backend contract items ship
separately in api.nodeterm.dev.
