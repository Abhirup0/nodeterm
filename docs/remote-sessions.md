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
`sendTo` no-ops) is what this seam makes fixable — the fix itself lands in 4c, when the
phone gets a real sink (see below).

### 4b → 4c interface (landed)

4b is **merged**: `electronPlatform` is genuinely multi-client. A relay peer is now a
first-class `CorePlatform` client of the desktop's core, so `presenceHub`, the Stage 3
canvas reflector and terminal co-attach already reach it — 4c only has to supply the
socket. What 4c consumes:

```ts
// src/main/peer-registry.ts
export function registerPeerSink(id: number, sink: UiSink): void
export function unregisterPeerSink(id: number): void

// src/core/ui-sink-registry.ts (shared with the Server Edition, which registers browsers)
export interface UiSink {
  sendText(json: string): void        // RPC event frame: {t:'ev', channel, args}
  sendBinary(buf: Uint8Array): void   // pty:data, encodePtyData(sessionId, chunk)
  bufferedAmount?(): number           // bytes queued in the socket send buffer
}
```

- **Ids come from `allocateRelayClientId()`** (`src/core/presence/hub.ts`) — monotonic
  from `1_000_000`, so a peer id can never collide with a webContents id (those start
  small and count up). 4c mints one per connection and uses the *same* id for
  `presenceHub.join`, `registerPeerSink`, and every `sendTo`.
- **`bufferedAmount()` MUST report the relay socket's real buffered bytes.** This is the
  single most important contract in 4b. Stage 2's per-client backpressure *and* the 8 MB
  `WS_DROP_WATER` drop-and-redraw ceiling key on that one number. A sink that always
  returns `0` looks fine in every test and silently disables the ceiling: a slow peer
  then queues pty output without bound, nothing ever pauses the pty or drops its backlog,
  and the **host's memory grows until the host process dies**. If the relay carrier has no
  native `bufferedAmount`, 4c must compute one (bytes handed to the socket minus bytes
  flushed) — an honest number, not a placeholder.
- **`onPeerGone` is already wired at boot.** `src/main/index.ts` calls `wirePeerRegistry({
  setFlow, captureForResync, onPeerGone: ptyManager.dropClient })` exactly once. **4c must
  NOT call `wirePeerRegistry` a second time** — the deps are last-write-wins, so a second
  call silently overwrites them. Just call `unregisterPeerSink(id)` on socket close (or
  revoke, per 4d): it mirrors `src/server/ws.ts`'s close path exactly — `presenceHub.leave`
  → `PtyManager.dropClient` → registry prune (which also returns any pty pause that peer
  owed, so a shared terminal cannot freeze for the other viewers).
- **A sink that throws twice consecutively self-evicts** (`SINK_FAILURE_LIMIT` = 2; any
  successful send resets the count) and gets the full teardown above. So 4c's sink should
  **throw on a dead socket rather than swallow** (a write to a half-closed stream throwing
  `EPIPE` / `ERR_STREAM_WRITE_AFTER_END` is the signal), and must **not** throw transiently
  on a healthy one — two throws in a row will kick a live peer out of the session.

What 4b explicitly does **not** do:

- **No connection code.** There is no relay socket, no handshake, no framing — 4b is the
  registry seam and nothing else. 4c brings the carrier.
- **`phone-presence.ts`'s half-join is NOT retired.** It still only joins the hub; the
  bridged phone registers no sink, so it still receives nothing. Retiring it is 4c's job,
  when it makes the phone a real peer (register a sink under the id it already mints).
- **No inbound peer→core cast path** beyond what `onWithSender` already provides: 4b makes
  the core able to *talk to* a peer, not to *hear* one. Routing a peer's RPC calls into the
  core's `handle`/`on`/`onWithSender` handlers (with the peer's id as the sender) is 4c.

Proven end-to-end by `src/main/peer-integration.test.ts` against the REAL platform + hub +
canvas reflector: a registered peer receives `presence:sync` / `presence:peer` and seq-stamped
`canvas:mut`, and pty output fans out to its sink as `sendBinary` frames under the per-client
backpressure + drop-and-redraw ceiling (a slow peer is dropped and redrawn without stalling
the host window or a fast peer).

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
- **Open product decision — license:** Pro currently gates only the host's token
  mint. The peer-to-peer story (host pays? both? invitee free?) is undecided; the
  spec records it as open rather than guessing.

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
| **4b** Client registry in `electronPlatform` | `feat/peer-registry` | — | **Landed** — peer sinks receive presence/canvas/pty through the real platform (`peer-integration.test.ts`); webContents path bit-identical; solo cost zero. Hand-off: "4b → 4c interface" above |
| **4d** Trust layer (keys, pins, mutual SAS, revoke) | `feat/peer-trust` | — | Crypto/pairing unit tests; revoke-kills-session hook tested against a fake connection |
| **4c** `rpc.ts` over relay; remote tab; delete old dialect | `feat/relay-rpc` | 4a+4b+4d | The 24 crypto-layer tests pass **unchanged**; new relay-carrier test (below); Stage 1–3 smoke script passes over relay |
| **4e** Server Edition as a tab | `feat/server-tab` | 4a+4c | Same smoke script against a Server Edition box |

4a, 4b and 4d run in parallel worktrees. 4c is the join point and must not ship to
users before 4d is wired (it grants `pty.create` to peers).

## 4a → 4c interface (landed)

The session layer lives in `src/renderer/session/` (`session.ts` + `localSession.ts`).
These are the exact exported names 4c builds against — do not rename:

- **Types / context:** `WorkspaceSession` (`{id, source, label, api, status}`),
  `SessionSource` (`'local' | 'relay' | 'server'`), `SessionContext`, `SessionProvider`.
- **Hooks:** `useSession()` (the current session; components read `useSession().api`),
  `useSessionStores()` (that session's per-session store instances),
  `useProjectSession(projectId)` (the session a tab belongs to).
- **Registry:** `createSession(source, api, label)` (idempotent per id; builds the
  per-session stores once), `getSessionStores(sessionId)`, `setActiveSession(sessionId)`,
  `getActiveSession()`, `activeSessionApi()` (non-component code's api accessor),
  `sessionForProject(projectId)` (runtime-only tab → session resolver; returns the
  local session today), `sessionCount()` (gates multi-session-only UI, e.g. the tab
  session label), `resetSessionsForTest()`.
- **Per-session store factories:** `createPresenceSession(api)` (`state/presence.ts`)
  and `createAgentStatusSession(persistKey?)` / `agentStatusForApi(api)`
  (`state/agentStatus.ts`) — the api-keyed entry points are **memoized by API
  IDENTITY**, so the local api resolves to the historical singleton instances and a
  repeat api never builds a second subscriber; `SessionStores` is the pair the
  registry holds per session.

The project → session binding is **runtime-only**: `workspace.json` / `project.json`
gained no field, and `state/projects.test.ts` has a tripwire asserting `toWorkspace()`
never emits a session field. `session/grep-gate.test.ts` enforces that no production
renderer file outside the session layer / bridge reads a core-bound namespace
(`pty|fs|git|chat|workspace|presence|canvas` + the agent event streams) off
`window.nodeTerminal`.

**Obligations 4c inherits** (surfaced by the 4a reviews — read before wiring a remote
session):

1. **A remote session's presence instance has no disposal path.** `createSession`
   builds the presence store (with its live subscription) and nothing ever tears it
   down. Whoever mounts a remote canvas MUST hold the teardown returned by the
   presence session's `connect()` and call it on disconnect, or the store keeps
   subscriptions on a dead connection.
2. **`setMe` only re-helloes its own session.** Renaming yourself updates and
   re-broadcasts on the session it was called on; another live session keeps
   broadcasting the old name until reload. 4c needs a fan-out across sessions or a
   shared identity slice.
3. **Resource effects capture `api` in their closures — 4c must REMOUNT on api
   change.** This is deliberate in 4a: adding `api` to a `[]`-dep resource effect
   (TerminalNode's PTY, EditorNode's Monaco, ChatNode's driver) would create a SECOND
   PTY/Monaco/chat driver on any api change. The consequence: if a session's api is
   ever swapped IN PLACE (reconnect building a new RPC client under the same session),
   those nodes keep talking to the OLD core until remount — and `EditorNode` would
   LOAD from core A and SAVE to core B. **4c must key the session's subtree by session
   id / api identity so an api change remounts it.** This is the most important line
   in this hand-off.
4. **`CloneRepoDialog`'s folder picker is client-local.** The native directory picker
   chooses a path on the CLIENT machine while the clone runs on the SESSION's core —
   harmless today (same machine), wrong on a remote tab. 4c must route the picker per
   session (the Server Edition's in-app server-directory browser is the precedent).
5. **Deferred namespaces still read off the global:** `sshProject`, `contextLink`,
   `context`, `transcripts`, `handoff`, `files`. They live in files 4c rewrites; 4c
   must decide each one (core-bound → session, or app-global → stays on the client).

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
