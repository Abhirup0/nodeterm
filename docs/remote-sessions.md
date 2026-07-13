# Remote workspace sessions — design (team, Stage 4)

**Date:** 2026-07-13
**Status:** approved, not yet implemented
**Depends on:** Stages 1–3 (`docs/team-presence.md`), all merged.

## Goal

Any remote nodeterm core opens as a **project tab** in the desktop app, with the full
feature set — terminals, git, editor, presence, co-attach, canvas sync. The headline
case: two desktops (e.g. two Macs) as **equal peers** on one shared canvas over the
E2EE relay. The same abstraction also opens a Server Edition box as a tab.

Stages 1–3 built multiplayer for clients that share ONE core. Stage 4 does not change
that model — it extends *which clients can attach to a core*. A desktop joining another
desktop is a client of the host's core, exactly as a browser is a client of the Server
Edition's core.

## Decisions (each made explicitly)

1. **Single workspace, equal rights.** The canvas, files and processes live on the
   host's machine; the peer joins with full rights (create/delete nodes, open
   terminals, type). "Equal" means equal *rights*, not mixed homing — a canvas never
   holds nodes from two machines. The asymmetry is real and documented: if the host
   sleeps, the peer's world freezes (and resumes via co-attach on reconnect).
   Mixed-home canvases (a `home` field per node) were considered and rejected for v1.
2. **Full trust, explicitly granted.** Inviting a peer grants shell access — the
   invite UI says so in plain words ("<name> will be able to run commands on this
   Mac — the same as giving them SSH access"). No per-action approval, no directory
   jail: after the first shell both are theater. The boundary is *who you invite*.
3. **A remote session is a project tab**, not a separate window and not a full-app
   takeover. Your local projects stay in their tabs; "Ayşe's Mac" sits beside them.
4. **The abstraction is source-agnostic.** A session's source is `local` (today's
   preload), `relay` (E2EE relay to another desktop), or `server` (WS to a Server
   Edition box). One refactor buys all three.
5. **One protocol.** `src/shared/rpc.ts` — the Server Edition's WS-RPC — becomes the
   only client↔core protocol, tunneled over the relay's E2EE socket for remote
   desktops. The relay's private opcode dialect (`framing.ts` OP codes, `snapshot.ts`,
   `host-service.ts`'s hand-rolled RPC vocabulary, `host-canvas-hub`'s full-state
   mirror, `sanitizeClientMutation`) is **deleted**, not deprecated — the app is
   unpublished, so this is the one moment that costs nothing. iOS (separate repo)
   migrates to `rpc.ts`; the phone cannot connect until that Swift work lands, and in
   exchange gains git, presence, agent status and co-attach, none of which the old
   dialect carried.
6. **Sub-stages, each independently mergeable** (see Split below): 4a ∥ 4b ∥ 4d in
   parallel branches, then 4c (the join point), then 4e.

## Architecture

### The Session abstraction (renderer)

Today the renderer assumes one core: `window.nodeTerminal` is a global and the stores
are singletons. Stage 4 introduces **Session** = a connection to one core + that
core's API:

```ts
interface WorkspaceSession {
  id: string
  source: 'local' | 'relay' | 'server'
  label: string                    // "Ayşe's Mac", "prod-box"
  api: NodeTerminalApi             // preload (local) or a bridged RPC client
  status: 'connected' | 'connecting' | 'offline'
}
```

Every project tab belongs to a session. `SessionContext` + `useSession()` provide the
API; `Canvas`, `TerminalNode`, `EditorNode` and the panels read it from context
instead of the global.

**The API splits in two** (measured: 221 call sites in 46 files):
- **Core-bound** (~90 calls — `pty`, `git`, `fs`, `workspace`, `presence`, `chat`,
  `canvas`, `agent`): routed per session. In a remote tab these hit the remote core.
- **App-global** (~60 calls — `updates`, `license`, `clipboard`, `shell`, `dialog`,
  `media`, `settings`, `pairing`): always local. Your update banner shows *your*
  version, never the host's.

**Stores become session-scoped.** `presence` and `agentStatus` hold per-session
tables (two sessions = two peer tables). This is the riskiest part of the refactor:
the presence store's module-level state (`connectPresence` idempotence, `lastFocus`,
the ws-bridge "exactly one subscriber" early-buffer invariant) must become
per-instance. Stage 1's invariants hold *per session*.

`TerminalTransport` note: the interface stays for the local path, but `RemoteTransport`
is deleted — a remote tab talks through a bridged `NodeTerminalApi` (the ws-bridge
builders), the same way the browser does. The load-bearing seam moves one level up:
from "swap the transport" to "swap the API object".

### The host side (main process)

Stages 1–3 are written against `CorePlatform` (`clientIds()`, `sendTo(id)`,
`onWithSender`) and already run multi-client every day on the Server Edition. The only
Electron blocker is that `electronPlatform` resolves clients as webContents:
`clientIds()` returns the main window only; `sendTo` uses `webContents.fromId`.

Fix: a **client registry**. `clientIds() = [mainWindow, ...peerIds]`; `sendTo`
dispatches by id to a webContents *or* a registered peer sink (the relay connection).
With that one seam, `presenceHub`, the Stage 3 canvas reflector and terminal co-attach
flow to a remote peer with no further changes — they never knew what a webContents
was. `phone-presence.ts`'s half-join (host sees the phone; the phone is blind because
`sendTo` no-ops) is retired by the same change.

### The protocol path (4c)

`rpc.ts` frames tunnel through the relay's existing E2EE socket. On the peer's side,
the renderer boots the **ws-bridge builders** over a relay-backed frame source instead
of a WebSocket — everything above the socket is shared with the browser path.

Two carrier requirements the relay socket must meet (the WS gave them for free):
- a `bufferedAmount` equivalent — Stage 2's per-client backpressure and the 8 MB
  drop-and-redraw ceiling key on it;
- FIFO delivery per connection — Stage 3's `seq` total order assumes it (the relay's
  single E2EE stream already provides this; it must stay single-stream).

Deleted with the old dialect: `framing.ts` opcodes, `snapshot.ts` (replaced by
`PtyCreateResult.screen`, which solved join-painting generally in Stage 2),
`host-service.ts`'s RPC vocabulary, `host-canvas-hub.ts` + `canvas:state` full-state
push (replaced by the seq-stamped reflector), `sanitizeClientMutation` (superseded by
the trust decision), `RemoteTransport`, `RemoteSessionView` (replaced by the remote
tab).

### Trust (4d — scoped to the crypto/pairing layer)

- The peer's device key becomes **persistent** (today the client key is ephemeral)
  and is **pinned on both ends**; SAS (6-digit) is verified **mutually**.
- Revocation is a first-class action (facepile avatar → "Remove"): it unpins the key
  **and kills the live session** — closes the relay connection, drops the peer's pty
  subscriptions, leaves presence. Unpinning alone would leave the peer connected.
- 4d deliberately does NOT touch the `host-service`/`client-service` handshake code —
  4c rewrites those files; 4d ships the key/pin/SAS/consent layer (`pairing.ts`,
  `e2ee.ts`, `approved-devices*`, invite/consent UI) as a library 4c wires in.
- **4d delivered (library, wired by 4c):** persistent peer identity
  (`src/main/remote/peer-identity.ts` + pure `key-file-codec.ts`); mutual SAS + pin-both-ends
  (`src/main/remote/mutual-approval-core.ts`); revocation with the `onRevoke` kill hook
  (`src/main/remote/revocation.ts` — unpin persists, then the hook cuts the live session); consent
  copy (`src/shared/remote/consent.ts` `describeGrant` + `ConsentNotice.tsx`). The existing crypto
  tests (`e2ee`, `pairing`, `relay-id`, `approved-devices-core`) pass unchanged.
- **Open product decision — license:** Pro currently gates only the host's token
  mint. The peer-to-peer story (host pays? both? invitee free?) is undecided; the
  spec records it as open rather than guessing.

### 4d → 4c interface (the exact seam 4c wires)

4d is an **inert library** — no connection code, no IPC, no UI beyond the leaf
`ConsentNotice`. Nothing runs until 4c wires it into the rewritten handshake. The exact
surface 4c consumes, gathered from the six 4d tasks:

**Persistent peer identity** (`src/main/remote/peer-identity.ts`, I/O wrapper — the only
4d module that imports `electron`):

```ts
function loadOrCreatePeerKeyPair(): Promise<KeyPair>   // throws PeerKeyLockedError (code E_PEER_KEY_LOCKED)
function resetPeerKeyCache(): void                     // test seam only
class PeerKeyLockedError extends Error                 // encrypted key + keyring locked ⇒ do NOT regenerate
```

Replaces the ephemeral `genKeyPair()` at `client-service.ts:286`. The public key is the
stable identity a host pins across reconnects. `PeerKeyLockedError` must surface to the
user ("unlock the keyring and reconnect") — never regenerate over it.

**Mutual approval** (pure, `src/main/remote/mutual-approval-core.ts` — no electron):

```ts
type MutualApproval    // opaque/branded; only emptyMutualApproval can construct it
function emptyMutualApproval(peerKeyB64: string, sessionId: string): MutualApproval
function confirmLocal(s: MutualApproval): MutualApproval
function confirmRemote(s: MutualApproval): MutualApproval
function isMutuallyApproved(s: MutualApproval): boolean
function recordApproval(store: ApprovedDevices, s: MutualApproval): ApprovedDevices   // pins s.peerKeyB64 only when both confirmed
function mutualSas(shared: Uint8Array): string                                        // "NNN NNN"; alias of sasFromSharedKey
```

Flow: `emptyMutualApproval(peerKeyB64, sessionId)` → `confirmLocal` on this human's SAS
match → `confirmRemote` on the peer's confirm frame → `recordApproval(store, state)` pins
the peer's key (each end pins the other's; idempotent). One state per pairing attempt.

**Revocation** (pure core + hook, `src/main/remote/revocation.ts` — no electron):

```ts
function revoke(store: ApprovedDevices, peerKeyB64: string): ApprovedDevices   // pure unpin, idempotent
type OnRevoke = (peerId: string) => void | Promise<void>
interface RevocationDeps { load(): Promise<ApprovedDevices>; save(s: ApprovedDevices): Promise<void>; onRevoke: OnRevoke }
interface RevokeResult { persisted: boolean; killed: boolean }
function createRevoker(deps: RevocationDeps): { revoke(peerKeyB64: string): Promise<RevokeResult> }
```

4c implements `onRevoke(peerId)` = close the peer's relay connection →
`PtyManager.dropClient(clientId)` → `presenceHub.leave(clientId)` (the same teardown
`peer-registry.ts` runs on sink unregister). `revoke()` unpins on disk FIRST, then fires
the hook. `persisted:false` ⇒ pin may survive, the UI must NOT show "Removed" and must
retry; `killed:false` ⇒ the cut is unconfirmed. `peerId` is the peer's stable box public
key (base64).

**Key-file codec** (pure, `src/main/remote/key-file-codec.ts` — no electron; `safeStorage`
injected as `SafeStorageLike`):

```ts
function encodeKeyFile(keys: KeyPair, safe: SafeStorageLike): string
function decodeKeyFile(raw: string, safe: SafeStorageLike): { keys: KeyPair; migrate: boolean } | null | 'locked'
```

`e2ee.ts` gained `secretKeyFromB64(b64)` (strict 32-byte, mirrors `publicKeyFromB64`) —
the only edit to a pre-existing crypto file, additive.

**Consent copy** (`src/shared/remote/consent.ts` + `src/renderer/remote/ConsentNotice.tsx`):

```ts
const SHELL_ACCESS_CONSENT: string
function describeGrant(peerLabel: string): string       // "<name> will be able to run commands on this Mac — the same as giving them SSH access."
function ConsentNotice({ peerLabel }: { peerLabel: string }): JSX.Element
```

4c places `<ConsentNotice peerLabel={…} />` in the actual invite/approve dialog.

#### SECURITY-FATAL obligations 4c MUST honour

These are the whole point of the trust layer. The pure modules cannot enforce them across
the connection seam — 4c owns them, and breaking any one silently grants a MITM shell
access on this machine:

- **(a) `confirmRemote` may be driven ONLY by a frame received over the ENCRYPTED,
  session-keyed channel** (the box under `deriveSessionKey`) — never a plaintext or
  relay-visible message. A forgeable/replayable "I confirmed" signal degrades mutual
  approval back to one-way: the relay supplies the confirmation the second human never
  gave, and a single local confirm then pins the attacker.
- **(b) Exactly ONE `MutualApproval` per pairing attempt**, constructed via
  `emptyMutualApproval(peerKeyB64, sessionId)` from THIS session's ECDH peer key (the same
  key whose shared secret produced the SAS the humans compared). No reuse across attempts,
  no seeding with a different key.
- **(c) Revocation must call the kill hook, not just unpin.** Unpinning refuses only the
  NEXT handshake; the open socket keeps full shell access until it drops on its own. 4c's
  `onRevoke` must cut the live session.
- **(d) Adopt the codec in `host-service.ts` too.** Its existing `loadOrCreateKeyPair`
  (`host-service.ts:548`) has the SAME keyring-lock flaw `peer-identity` fixed: an encrypted
  `secretKeyEnc` key read while `isEncryptionAvailable()` is false at boot falls through both
  read branches and regenerates a fresh key (line 574), overwriting the good encrypted
  identity and forcing every host that pinned it to re-approve. 4d left `host-service.ts`
  untouched by design; 4c should route it through `key-file-codec` + the `'locked'` outcome.

### Persistence

A remote tab is a **connection bookmark**, never a workspace on the peer's disk — the
files live on the host; the peer cannot own them. Offline, the tab renders greyed
"unavailable" (reusing the workspace index's existing unavailable-ref rendering) and
reconnects on click. Host asleep ≠ data loss: processes keep running in the host's
tmux; reconnect re-enters via co-attach (Stage 2 already guarantees this).

**Documented limitation:** canvas edits made by the peer while disconnected are lost
(no offline queue in v1). Accepted, recorded here so nobody discovers it in the field.

## Split — branches and gates

| Sub-stage | Branch | Depends on | Merge gate |
|---|---|---|---|
| **4a** Session abstraction (renderer; local-only) | `feat/session-abstraction` | — | **Behavior-unchanged**: full suite + typecheck green, zero visible diff for a solo user |
| **4b** Client registry in `electronPlatform` | `feat/peer-registry` | — | Fake peer sink receives presence/canvas/pty events; webContents path bit-identical |
| **4d** Trust layer (keys, pins, mutual SAS, revoke) | `feat/peer-trust` | — | Crypto/pairing unit tests; revoke-kills-session hook tested against a fake connection |
| **4c** `rpc.ts` over relay; remote tab; delete old dialect | `feat/relay-rpc` | 4a+4b+4d | The 24 crypto-layer tests pass **unchanged**; new relay-carrier test (below); Stage 1–3 smoke script passes over relay |
| **4e** Server Edition as a tab | `feat/server-tab` | 4a+4c | Same smoke script against a Server Edition box |

4a, 4b and 4d run in parallel worktrees. 4c is the join point and must not ship to
users before 4d is wired (it grants `pty.create` to peers).

## Testing

- **Core tests are transport-agnostic** (~150 tests against the `CorePlatform` fake)
  and already cover presence/co-attach/convergence — they prove the core, unchanged.
- **4a's gate is the strongest**: a pure refactor proven by "nothing changed" — the
  entire existing suite, plus a grep gate (no `window.nodeTerminal.pty|git|fs|...`
  outside the session layer).
- **The new relay-carrier test (4c's core deliverable):** two cores in one test
  process joined by an in-memory relay, `rpc.ts` tunneled; asserts hello→presence
  sync, cross-tunnel co-attach (one spawn, both painted), `canvas:mut` seq stamping,
  and the backpressure signal (a slow peer trips the drop-and-redraw ceiling).
- **Blast radius of deleting the old dialect** — 18 test files, ~97 tests, three fates:
  - *deleted with the code* (~49): `framing`, `snapshot`, `host-handlers`,
    `client-handlers`, `host-canvas-sync`, relay `canvas-sync`,
    `client-canvas-router`, `remote-fs` — they test the dialect itself; the
    replacement path has its own net on the Server Edition side.
  - *must survive unchanged* (~24): `e2ee`, `pairing`, `relay-id`,
    `approved-devices-core`, `relay-socket` — the carrier + crypto layer. A 4c that
    breaks any of these has cut too deep; this is an explicit merge gate.
  - *rewritten* (~20 + 2 skipped e2e): `remote-security`, `standing-host`,
    `host-service.presence`, `relay-e2e`, `b5-e2e` — same concerns, new protocol.
- **Manual acceptance = the Stage 1–3 two-client smoke script, unchanged, over the
  relay** between two app instances (`NT_MULTI=1 NT_USER_DATA=...` — already
  supported), plus relay-specific steps: host sleep/wake (peer's terminal returns via
  co-attach), cable pull, revoke mid-session (peer is cut immediately), edits while
  disconnected (verify they are lost *and* nothing corrupts).

## iOS (separate repo — tracked, not same-PR)

The Swift client rewrites its wire layer against `rpc.ts` (it currently speaks the
deleted opcode dialect). Until that lands the phone cannot connect. It then gains:
named presence (`presence:hello`), git, agent status, co-attach, and the typing badge
it already half-had. The nodeterm-side protocol work is complete at 4c; the iOS task
should be filed the day 4c merges.

## Out of scope (v1)

Mixed-home canvases; an offline edit queue; >LWW conflict semantics (Stage 3's
documented races carry over); voice/video; follow mode; guest/read-only roles;
license enforcement changes (open decision above).
