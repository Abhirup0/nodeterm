# Design: live (shared) dino game — spectator mode

**Date:** 2026-07-14
**Branch:** `feat/dino-live` (worktree `/root/nodeterm-dino`, off `main`)
**Status:** LANDED on `feat/dino-live` (full suite + typecheck green). Two-instance acceptance:
A opens a dino on the shared canvas + presses Space → B watches the SAME dino run live with a
"▷ A is playing" pill; B presses Space → control moves to B (A becomes spectator); A closes the
node / disconnects → B's dino falls back to idle ("Click, then Space to play"). Solo play unchanged.

## Problem

The dino node (`DinoNode.tsx` + `dino/dino-game.ts`) is a self-contained T-Rex runner whose
per-frame state (dino y/velocity, obstacles, score, crashed) is **purely local** (a `requestAnimationFrame`
loop on a `<canvas>`). Presence + canvas-sync only carry cursors/chat and node create/move/delete
mutations — never the game's internal state. So on a shared canvas (a relay tab, a Server-Edition
browser, or two local co-viewers), when A plays, A sees the dino run and B sees an independent, idle
dino. The user's expectation: **"canlı" = both watch the same game live.**

## Decision (approved)

**Spectator model.** One authoritative player runs the physics; every other viewer on that project
watches the SAME game live. Whoever presses Space on a dino nobody is broadcasting becomes the
authority; a spectator who presses Space **takes over** (the old authority flips to spectator). One
physics sim, one authority → no input-conflict, no determinism requirement.

## Mechanism — piggyback on presence (no new core channel)

The whole feature rides the presence layer (which Stage 1-3 built and the collab branch just made
session-aware, so it already flows over local / relay / Server-Edition via `presenceHub` /
`CorePlatform`). The authority broadcasts its game snapshot as an **ephemeral peer-state field**,
exactly like the cursor and the chat bubble.

### Data
- `src/shared/presence.ts` `PeerState` gains:
  ```ts
  /** The live dino game this peer is the AUTHORITY for, or null. Ephemeral (like `chat`):
   *  cleared when the peer stops playing / blurs / closes the node / leaves. A spectator renders
   *  the snapshot for the matching node id instead of running its own sim. */
  dino: { nodeId: string; snap: DinoSnapshot } | null
  ```
- `DinoSnapshot` (new, in `shared/presence.ts` or a sibling `shared/dino.ts`) — the minimal state a
  spectator needs to draw one frame:
  ```ts
  interface DinoSnapshot {
    y: number            // dino offset above ground (<= 0)
    ducking: boolean
    crashed: boolean
    started: boolean
    score: number
    speed: number        // for the running-frame cadence + ground scroll
    groundScroll: number
    obstacles: { kind: 'cactus' | 'bird'; x: number; y: number; sx: number; sw: number; sh: number; flap: number }[]
  }
  ```
  This is small (a handful of numbers + ≤ ~6 obstacles). **Size-capped** at the hub like `chat`
  (a `DINO_MAX_OBSTACLES` clamp + a byte ceiling) so a malformed/oversized cast can't flood the wire.

### Wire (mirrors `chat` exactly)
- `IPC.presenceDino = 'presence:dino'` (a cast, client→server, like `presenceChat`).
- Preload `presence.dino(payload: { nodeId; snap } | null)` → `ipcRenderer.send(IPC.presenceDino, payload)`
  (bridge shim for the browser too — `src/renderer/bridge`).
- `presenceHub` (`src/core/presence/hub.ts`) handles `presence:dino`: validate/clamp, set the sender's
  `PeerState.dino`, broadcast a `PeerDiff` `update` — the same dumb-reflector path as `chat`.
- On disconnect / leave the hub already drops the peer's whole state, so `dino` clears for free.

### DinoNode / game
`DinoNode.tsx` is under the active-session `SessionProvider`, so it already resolves the active
session's presence (via `useActiveSessionPresence()` / `useSession().api`). Two additions:

1. **Broadcast (authority).** `createDinoGame` gains an `onSnapshot(snap | null)` callback throttled
   to `DINO_BROADCAST_HZ = 20` (driven off the existing rAF `frame`, same rate as the cursor). The
   authority broadcasts whenever a run is **in progress or on the GAME OVER screen** (`started ||
   crashed`) so spectators see both the run and the crash; it broadcasts `null` (stop) when the game
   returns to the pre-start idle state (blur → `stop()`, node unmount, or a reset that has not been
   re-started). Concretely DinoNode wires `onSnapshot` → `api.presence.dino({ nodeId: id, snap })`,
   and calls `api.presence.dino(null)` on blur / unmount / when `onSnapshot` yields `null`.
2. **Spectate.** DinoNode subscribes (reactively — it is a presence *component*, allowed to) to
   whether any OTHER peer is broadcasting a `dino` whose `nodeId === this node's id`. When one is,
   the node enters **spectator mode**: `createDinoGame` is told `setRemote(snap)` each time a new
   snapshot arrives and renders THAT instead of running its own `update()` (its own input +
   physics + spawn are suspended; it only draws). When no peer is broadcasting for this node, it
   returns to **local play** (own sim, as today). A tiny "▷ <name> is playing" label (peer color)
   marks a spectated node.

### Authority + handoff
- Local play or "take over": your own Space/Arrow input makes YOU the authority — you start your own
  sim (a spectator seeds it from the last remote snapshot for continuity) and begin broadcasting.
- The old authority sees a peer now broadcasting for that node id → flips to spectator. (While it is
  still broadcasting too, both briefly publish; the tiebreak is **lower `clientId` wins** — the
  higher-id peer yields to spectator. Self-heals within a couple of frames. Acceptable for an
  easter egg; documented.)
- Score / high-score: the live score rides in the snapshot (spectators see it). The project record
  (`setDinoHighScore`) + the node's `highScore` mutation are unchanged — the AUTHORITY's crash
  updates them as today; spectators pick the record up via the existing project value.

## Components / boundaries
- `shared/presence.ts` — `PeerState.dino` + `DinoSnapshot` + the cap constants (pure types/consts).
- `src/core/presence/hub.ts` — one new cast handler (`presence:dino` → validate/clamp → set → diff),
  mirroring the `chat` handler. Unit-testable against the existing hub test harness.
- `src/shared/ipc.ts` + `src/preload/index.ts` + `src/renderer/bridge/*` — the `presence:dino`
  channel + api member (+ the browser bridge shim; a `satisfies` gate forces the declaration).
- `src/renderer/state/presence.ts` — `PresenceSession` gains a `dino(payload)` write + a `selectDino(nodeId)`
  selector (peers broadcasting for a node), following `chat`/`selectVisible`. Session-aware for free.
- `src/renderer/nodes/dino/dino-game.ts` — `onSnapshot` throttled emit + `setRemote(snap)` + a
  `remote` render branch (draw the snapshot; suspend own update/input). Keep the file self-contained.
- `src/renderer/nodes/DinoNode.tsx` — wire `onSnapshot` → `api.presence.dino`, subscribe
  `selectDino(id)` → `setRemote` / authority flip, the "is playing" label.

## Error handling / edge cases
- **Malformed/oversized snapshot:** hub clamps obstacle count + rejects over the byte cap (like chat);
  a bad cast is dropped silently, never applied.
- **Authority leaves mid-game:** the hub drops its `dino` on `leave` → spectators fall back to idle
  ("Click, then Space to play") — no frozen ghost.
- **Two peers press Space at once:** lower-clientId wins; the other yields to spectator within a
  couple frames. No crash, no double-authority persisting.
- **Solo user (no peers):** `selectDino` is empty, `onSnapshot` still fires but the api cast is a
  no-op with no peers (same as cursor today) — zero behavior change. Local play is byte-identical.
- **Perf:** broadcast throttled to ~15-20 Hz and size-capped; a spectator renders the snapshot
  INSTEAD of running its own sim (no double work). Presence-component subscription only (never a
  Canvas re-render — the perf contract is unaffected; DinoNode already re-renders on its own state).

## Three surfaces
- **Desktop / relay tab / Server-Edition browser:** works automatically — presence flows over the
  session core (local, relay tunnel, or WS) via the hub; the bridge shim covers the browser.
- **Mobile:** the phone is on the retained old opcode dialect (no rpc presence), so it neither sees
  nor broadcasts dino — a graceful degrade, identical to how the phone already lacks named presence /
  cursors. Documented; a follow-up rides the phone's eventual rpc migration.

## Testing
- **Hub** (`src/core/presence/hub.test.ts`): a `presence:dino` cast sets the sender's `dino` and
  broadcasts an `update` diff; an oversized/over-count snapshot is clamped/dropped; `leave` clears it.
- **Presence session** (`state/presence.test.ts`): `selectDino(nodeId)` returns a peer broadcasting
  for that node and excludes self / other nodes; `dino(payload)` casts on the api.
- **dino-game** (`dino/dino-game.test.ts` if a seam exists): `setRemote(snap)` makes the game render
  the snapshot and suspend its own update; `onSnapshot` throttles to ~the target rate. (Canvas draw
  is not unit-tested; test the state machine + the throttle.)
- **Manual two-instance:** A opens a dino on the shared canvas, presses Space → B watches the SAME
  dino run live (with A's name label); B presses Space → control moves to B, A becomes spectator;
  A closes the node / disconnects → B's dino falls back to idle.

## Out of scope (v1)
Co-op control (both jump the same dino); per-frame determinism / input-replay; mobile dino;
persisting a game across a disconnect; a spectator "join the run" split-screen.

## Merge gate
No crypto/handshake file touched. Full suite + typecheck green. Whole-branch review (perf contract:
no new Canvas re-render on the 20 Hz snapshot; local byte-identical; the hub cap can't be bypassed).
Then merge to main.
