# Team Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each task is a
> fresh subagent + two-stage review. TDD, minimal diffs, commit per task.

**Goal:** Turn the single-peer relay host into a paid, multi-seat "Team Access" — the paying host
shares this Mac with up to `seats` devices (one seat per connected device), invited by email,
$5/seat (billed by Stripe, backend).

**Architecture:** The core (`CorePlatform.clientIds()`, presence, canvas-sync) is already N-client;
only the relay-host LISTENER is single (`relay-host-service.ts` `current`). Change it to a pool of up
to `seats` `RelayHostSession`s; `seats` comes from the license entitlement (backend adds the field;
absent → 1). Add a Settings → Team Access section (pitch, seat counter, connected-device list with
email labels + per-peer Remove, invite→code+share, add-seats CTA). Trust is unchanged: each seat is a
separate mutual-SAS + ConsentNotice grant.

**Tech Stack:** Electron main/renderer/preload, TypeScript, the existing relay tunnel
(`connectRelayHost`, `mintPairingToken`, `killRelayHostsByPeerKey`), Ed25519 entitlement
(`core/license.ts`), zustand renderer stores, vitest.

## Global Constraints
- **No crypto/handshake file changes** (relay-socket/trust/client/host, e2ee, pairing, revocation,
  mutual-approval, identity). This is pool-management + one entitlement field + UI. The whole-branch
  review verifies the diff touches none of them.
- **Backward compat:** `seats` absent → **1** → bit-for-bit today's single-peer behavior. Hosting
  still gates on `isPremium` (unchanged) — a free user cannot host.
- **Trust unchanged:** every seat goes through the existing per-session mutual-SAS + ConsentNotice.
  The seat cap is UX/host enforcement, NOT a security boundary (comment it at the enforcement site).
- **Backend is a separate repo** (api.nodeterm.dev): the `seats` signer (Stripe per-seat), real email
  delivery, and v2 server-side enforcement are documented follow-ups, not built here.
- English for all code/comments/UI copy. Match surrounding style. Subagent model: Opus 4.8.

---

### Task 1: `seats` in the license entitlement

**Files:**
- Modify: `src/core/license.ts` (`Payload`, `LicenseStatus`, `statusFrom`, a `getSeats()`/exposed field)
- Modify: `src/shared/types.ts` (the `LicenseStatus`/license-api shape the renderer sees, if seats surface there)
- Test: `src/core/license.test.ts` (or the existing license test)

**Interfaces:**
- Produces: `LicenseStatus.seats: number` (resolved: premium+field → N; premium+no field → 1; not
  active → 0). A main-side getter `licensedSeats(): number` the relay-host reads (Task 2).

**What to build:**
- `Payload` gains optional `seats?: number` (the backend signs it into the Ed25519 token; verified
  offline exactly like `tier`/`exp` — no new verification path).
- `statusFrom` resolves `seats`: active premium → `payload.seats ?? 1`; inactive/free → `0`.
- Expose `seats` on `LicenseStatus` and a `licensedSeats()` helper (reads the current verified token →
  the resolved seats) for the main process to consult for the cap.
- Do NOT change the `isPremium` gate or any verification/expiry logic.

**Tests (TDD):** a token with `seats:5` (premium) → status.seats 5; a premium token with no seats
field → 1; an expired/invalid/free token → 0. `licensedSeats()` returns the same.

---

### Task 2: Multi-peer relay pool + invite/revoke (the core)

**Files:**
- Modify: `src/main/remote/relay-host-service.ts` (single `current` → a pool; `relay:host:invite`,
  `relay:host:revoke`; `onOpen`/`onClosed` carry seat id + email; `stop()` closes all)
- Modify: `src/shared/ipc.ts` (`relayHostInvite`, `relayHostRevoke`; `relay:host:open`/`closed`/
  `peer-pending` payloads gain `email?`)
- Modify: `src/preload/index.ts` + `src/shared/types.ts` (`relayHost.invite(opts) → {offer}`,
  `relayHost.revoke(id)`) + `src/renderer/bridge/*` (shims — desktop-only path; a browser bridge
  stub/degrade is fine since hosting is Electron)
- Create: `src/main/remote/seat-cap.ts` (pure `canAcceptSeat(liveCount, seats): boolean`)
- Test: `src/main/remote/relay-host-service.test.ts`, `src/main/remote/seat-cap.test.ts`

**Interfaces:**
- Consumes: `licensedSeats()` (Task 1); the existing `connectRelayHost`, `mintPairingToken`,
  `killRelayHostsByPeerKey`, `RelayHostSession` (unchanged — do NOT modify the handshake files).
- Produces: `relay:host:invite {projectId?, email?} → { offer }` (mints ONE pairing, adds to pool,
  cap-checked, returns the offer to share; refuses with `E_SEATS_FULL` at cap); `relay:host:revoke
  {id}` (closes ONE live session); `relay:host:open`/`closed`/`peer-pending` events now carry the
  seat's renderer id + `email?`.

**What to build:**
- Generalize the single `current` to a pool (keep `byId: Map<rendererId, RelayHostSession>` as the
  live/pending set; drop the `current` single-slot supersede).
- `relay:host:invite`: gate on `isPremium` + `relayAllowed` (as `start` does today) → check
  `canAcceptSeat(livePeers, licensedSeats())`; if full, throw `E_SEATS_FULL`. Else
  `connectRelayHost(...)` a NEW session (do NOT close others), hold the `{email}` on it, add to the
  pool, return `{ offer }`. (This REPLACES the superseding `start`; keep `start` as an alias/compat if
  anything calls it, or migrate callers — check `RemoteAccessDialog`/`RemoteSection` which call
  `relayHost.start()` and route them to `invite`.)
- `onOpen(session)` → emit `relay:host:open { id, email }`; `onClosed` → remove from pool, emit
  `relay:host:closed { id }`. Peer-pending carries `email`.
- `relay:host:revoke {id}` → resolve the session in the pool → `killRelayHostsByPeerKey(peerKey)` for
  its peer (or `session.close()`), which cuts the live socket + unpins (the 4c mechanism); remove
  from pool. A code comment: host-side cap is UX, not server-guaranteed.
- `stop()` closes ALL sessions in the pool.
- Cap comment: enforcement is host-side/UX (v2 = server-side).

**Tests (TDD):** `invite` adds a session + returns an offer; a 2nd `invite` at cap(1) →
`E_SEATS_FULL`; with cap 3, three invites succeed and a 4th is refused; `revoke(id)` closes only that
session (spy the close) and frees a seat so a fresh invite succeeds; `onClosed` frees the seat;
`stop()` closes all; `email` rides peer-pending/open. `seat-cap.test.ts`: `canAcceptSeat(0,1)=true`,
`(1,1)=false`, `(2,3)=true`, `(3,3)=false`, `(n,0)=false`. **Run the crypto/carrier gate unchanged.**

---

### Task 3: Team Access renderer store (live seats + pending)

**Files:**
- Create: `src/renderer/state/teamAccess.ts` (zustand store) + pure `teamAccessCore.ts` if a
  reducer helps
- Modify: `src/renderer/canvas/Canvas.tsx` OR a small effect module — subscribe to
  `relayHost.onPeerPending/onOpen/onClosed` and feed the store (mirror how the existing relay-host
  renderer events are consumed)
- Test: `src/renderer/state/teamAccess.test.ts`

**Interfaces:**
- Consumes: `relayHost.onPeerPending/onOpen/onClosed` (Task 2 events, now with `email`/`id`).
- Produces: `useTeamAccess` store: `{ seats: SeatEntry[] }` where `SeatEntry = { id, email?, name?,
  color?, status: 'pending' | 'connected' }`; selectors `usedCount()`, `pending()`.

**What to build:** a transient store of the live/pending seats, updated on open (→ connected, attach
the peer's presence name/color if resolvable) / closed (→ remove) / peer-pending (→ pending, with
email). Cleared on host stop. The presence name/color for a seat can come from the presence store by
matching the peer — keep v1 simple (email label + a generic "connected" if the presence name isn't
easily joinable; note it).

**Tests (TDD):** peer-pending adds a `pending` seat with its email; open flips it to `connected`;
closed removes it; `usedCount()` counts connected. RED→GREEN.

---

### Task 4: Settings → Team Access section (the product surface)

**Files:**
- Create: `src/renderer/components/settings/sections/TeamAccessSection.tsx`
- Modify: `src/renderer/components/settings/SettingsPage.tsx` (register the nav entry + route)
- Modify: `src/renderer/components/settings/nav.ts` (or wherever the section list lives)
- Create: `src/renderer/components/settings/teamAccessView.ts` (pure view-model — testable)
- Modify: `src/renderer/styles.css` (section styling)
- Test: `src/renderer/components/settings/teamAccessView.test.ts`

**Interfaces:**
- Consumes: `useTeamAccess` (Task 3), the license status `seats` (Task 1), `relayHost.invite`/`revoke`
  (Task 2), the license checkout opener (existing), `shell.openExternal` (for mailto/checkout).
- Produces: the UI. Pure helpers: `teamAccessView({ premium, seats, used }) → { gated, counterText,
  canInvite }`; `inviteShare({ offer, email }) → { copyText, mailtoUrl }`.

**What to build:**
- **Gate:** not premium → the pitch ("Share this Mac with your team — $5/seat/month") + a
  **Get Team Access** button opening the Stripe checkout (existing `license` checkout URL). Premium →
  the panel.
- **Seat counter:** `Used {used} / {seats}` from the store + license.
- **Connected devices list:** one row per seat (`useTeamAccess`) — email label + presence name/color
  (if available) + a **Remove** button → `relayHost.revoke(id)`. Pending rows show "waiting to
  connect…".
- **Invite:** an email `<input>` → **Generate invite** → `relayHost.invite({ email })` → show the
  returned offer code + a share row **[Copy] [Open in Mail]** (`inviteShare` builds the copy text +
  a `mailto:{email}?subject=...&body=...` with the code+link; `shell.openExternal` opens it). At cap,
  the invite is disabled with "All seats in use — add a seat".
- **Add seats CTA:** opens the checkout (quantity handled by Stripe).
- Match the existing settings-section look; keep copy honest (this grants shell access — reuse the
  ConsentNotice framing in the pitch).

**Tests (TDD):** `teamAccessView` — not premium → gated; premium+used<seats → canInvite; used==seats →
!canInvite; counterText. `inviteShare` — the mailto contains the code + the invitee email + a body.
JSX relies on typecheck.

---

### Task 5: Gate + docs + acceptance

**Files:**
- Modify: `docs/remote-sessions.md` (Team Access section: multi-seat, device-seat model, host-side
  cap, per-peer revoke now wired, the backend contract follow-ups); flip the 4c "per-peer revoke UI"
  follow-up to landed.
- Modify: the Team Access spec status → landed.

**What to build / do:**
- `npm run typecheck` + full `npx vitest run` green (the pre-existing workspace-watcher fs-timing
  failure is the only allowed red — confirm it also fails on plain main).
- Confirm NO crypto/handshake file changed (`git diff --name-only main..HEAD | grep -iE
  'relay-socket|relay-trust|relay-client|relay-host\.ts|e2ee|pairing|revocation|mutual-approval|
  identity'` → empty; note `relay-host-service.ts` and `relay-host.ts` are different — the service is
  ours to change, the `.ts` handshake is NOT).
- Docs: the Team Access model + the N-instance acceptance checklist (host seats≥3, invite 2, both
  connect via SAS+consent, list shows email labels + Used 2/3, Remove drops one, a 4th invite past
  cap is refused, cursors/chat/dino from all peers).
- Backend contract recorded for the api.nodeterm.dev effort (seats signer, email delivery, v2
  server enforcement).

## Merge gate
Whole-branch security review: multi-peer shell access (each seat a separate SAS grant), the cap is
UX, revoke cuts the LIVE socket, no crypto/handshake file touched, backward-compat (seats absent → 1,
free can't host). Then merge to main; the backend items ship separately.

## Self-review (coverage)
- Spec A (multi-peer pool) → Task 2. B (entitlement seats) → Task 1. C (settings section) → Task 4.
  D (per-peer revoke) → Task 2 (mechanism/IPC) + Task 4 (Remove button). E (email label) → Task 2
  (carried) + Task 3 (store) + Task 4 (shown). Backend contract → Task 5 docs. Security → Task 5
  review gate. All covered.
