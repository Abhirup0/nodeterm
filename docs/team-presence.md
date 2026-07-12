# Team presence — design

**Date:** 2026-07-12
**Status:** approved, not yet implemented
**Scope:** live cursors with names, ephemeral cursor chat, per-node "who is active here",
and the terminal co-attach that makes those indicators mean something.

## Goal

Turn nodeterm from a single-operator canvas into one a small team (~5–10 people) can inhabit
at the same time: you see where your teammates' cursors are, you can say something quickly
without leaving the canvas, and you can see who is sitting in — and typing into — a given
terminal. Two people can look at the same terminal at the same time.

This is deliberately a *presence* feature, not a permissions feature. Identity is weak,
there is no locking, and there are no roles. See Non-goals.

## Constraints discovered in the codebase

Three facts shaped every decision below:

1. **There is no notion of a user anywhere.** Server Edition auth is a single shared
   password (scrypt) with anonymous session tokens (`src/server/auth.ts`); the license layer
   identifies a *device*, not a human (`src/core/license.ts`). Identity is invented from scratch.
2. **Multi-client transport already exists.** `ServerPlatform.sinks` is a real client registry
   (`src/server/platform-server.ts:104`) and `broadcast()` (`:96`) already fans out
   `agent:status` and friends to every connected client. Presence needs no new transport.
3. **Terminals are not shareable today.** PTY output is unicast to the creating client
   (`Session.webContentsId`, `src/core/pty-manager.ts:251`, flushed at `:780`), and a second
   client attaching to the same node runs `tmux -A -D` (`:668`) — the `-D` *detaches the other
   client*. Two browsers on one node fight, and output follows whoever attached last.

## Architecture

### PresenceHub lives in core, not in a shell

New `src/core/presence/hub.ts`: a pure `PresenceHub` holding `Map<clientId, PeerState>`,
applying events and emitting diffs. No electron, no `ws`, no disk. **Presence is never
persisted** — it is as transient as the live half of `agentStatus`.

Both shells feed the same hub through the same interface:

- **Server Edition** — `ServerPlatform.attach()/detach()` (`platform-server.ts:104`) is already
  the client registry; `hub.join(uiId)` / `hub.leave(uiId)` hook in there, and fan-out uses the
  existing `broadcast()`.
- **Relay / desktop host** — a `HostSession` connecting calls the same `hub.join()`.
  `host-canvas-hub` already mirrors canvas state to N clients via its `subs` set; presence
  rides the same path.

One hub, two adapters — not two implementations.

### Identity: lightweight, unverified, deliberate

Auth is untouched (one shared password stays). On first connect the browser asks for a name;
`{name, color}` is kept in `localStorage` under `nodeterm.presence.me`, with a color
auto-assigned from a palette and user-changeable. The client announces itself with
`presence:hello {name, color}`; the server assigns a `clientId` (the existing `uiId`).

The server does not verify names. Anyone can claim to be anyone. This is sufficient for "who
is typing in this shell" and insufficient for audit or permissions — an accepted, documented
trade-off. Two tabs from one person show as two peers (as in Figma).

### Peers may have no cursor

`PeerState = { clientId, name, color, cursor: {x,y} | null, focus: nodeId | null, chat: string | null }`

**`cursor`, `focus` and `chat` are three independent signals**, and a cursorless peer is a
first-class citizen — not a peer with a fabricated position. The mobile companion has no
mouse; modelling presence as "everyone has an x/y" would have forced it to either invent a
cursor or vanish. Every UI surface degrades per signal.

### Wire protocol

New `presence:*` channels in `src/shared/ipc.ts`. The server is a dumb reflector: it holds the
peer table and fans out, and applies no policy.

| Direction | Channel | Payload |
|---|---|---|
| client→server (`cast`) | `presence:hello` | `{name, color}` |
| client→server | `presence:cursor` | `{x, y}` — **flow coordinates**, sampled on rAF, throttled to ~20 Hz |
| client→server | `presence:focus` | `{nodeId \| null}` |
| client→server | `presence:chat` | `{text \| null}` — live per-keystroke; `null` closes |
| server→clients (`ev`) | `presence:sync` | full snapshot on join |
| server→clients | `presence:peer` | single-peer diff (join / update / leave) |

Cursors travel in **flow coordinates** (`screenToFlowPosition`), never screen coordinates, so a
cursor lands on the correct node regardless of each viewer's zoom and pan.

## Terminal co-attach

The enabling change: two people must be able to watch one terminal.

**One PTY, N subscribers** — *not* "drop tmux's `-D`". When a second client calls `pty.create`
with a live `persistKey`, we do not spawn a second tmux client; we subscribe it to the existing
`Session`. The app therefore still has exactly one tmux client per session, `-D` stays as it is,
and tmux's multi-client size negotiation never engages. The relay path already does exactly this
(`attachDetached`, `src/core/pty-manager.ts:485`) — we generalize that mechanism rather than
inventing a second one.

Changes:

1. **`Session.webContentsId: number | null` → `subscribers: Set<ClientId>`**
   (`pty-manager.ts:251`). `flush()` (`:780`) fans out to the subscriber set instead of
   unicasting. Relay `onData` sinks live in the same set — two paths collapse into one.
2. **`pty:create` becomes idempotent.** A live session for that `persistKey` means subscribe +
   return `fresh:false` rather than spawn. Cold-restore and scrollback replay already branch on
   `fresh`, so they keep working.
3. **Size: smallest subscriber wins.** Two browsers at different zoom/DPI compute different
   cols/rows and would corrupt each other's rendering — the classic shared-terminal problem.
   PtyManager tracks each subscriber's requested size, sets the effective size to
   **min(cols) × min(rows)**, and broadcasts the authoritative size on `pty:size:<sessionId>`.
   Each xterm calls `term.resize()` from that broadcast instead of from its own `fit()`, and
   letterboxes the remainder. With one subscriber, `min` of one element is your own size — the
   **single-user path stays bit-for-bit identical to today**.
4. **Backpressure becomes per-client.** Today `paused` is keyed by session
   (`platform-server.ts:39`) and `detach()` clears the *entire* map on any disconnect — a bug
   already confessed in a "v1 is single-UI" comment (`:110`). Left alone, one slow phone would
   stall everyone's output. Rekey to `(clientId, sessionId)`; detach clears only that client's
   entries.

### Typing attribution — and why it is server-side

`cast()` currently discards the sender (`platform-server.ts:136`, `void uiId`). We route
`pty:write` through the existing `handleWithSender` seam (`:55`), so the handler can stamp
`session.lastWriter = {clientId, at}`. The hub broadcasts that, throttled to 1/500 ms per node;
the badge decays after ~2 s.

Attribution is done **on the server rather than by client self-declaration** specifically
because of mobile: when the phone writes over the relay, the sender is already known as a
`HostSession`. So *typing from the phone lights up the "Enes is typing" badge on someone's
desktop canvas without a single line of Swift.*

### No locking (v1)

Two people can type into one shell simultaneously; both badges pulse and the characters
interleave in the single tmux session. This is accepted, not overlooked — it is the behavior
every tmux pair-programmer already knows, and the badge *is* the warning. Locking / handoff is
v2.

If a node is deleted while others are attached, `destroy(persistKey)` kills the tmux session and
the remaining subscribers enter a "closed by <name>" state rather than respawning it.

## Canvas sync

Node edits broadcast as mutations so cursors don't hover over stale geometry.

The vocabulary already exists — `CanvasMutation = {op:'upsert', node} | {op:'remove', id}`
(`src/shared/types.ts:119`) — and so does the receiving end: `applyCanvasMutation`
(`Canvas.tsx:917`), written for the relay. We add only the emitting side: `handleNodesChange`
publishes a mutation (position-only, throttled to 20 Hz, while dragging; a full upsert on
settle; an upsert on add / remove / color / title / collapse), and the server reflects it to
every client except the sender.

Convergence makes persistence safe for free: because all clients converge on the same node set,
whichever client calls `workspace.save` writes the same bytes, which defuses today's
last-writer-wins save. The existing rev-based conflict bar (`workspace-watcher`) stays as the
backstop.

Two things are deliberately **not** synced: ephemeral nodes (subagent / loop cards) are derived
independently on each client from the already-broadcast `agent:status` stream; and undo stays
**local per user** — you can in principle undo someone else's change (last-write-wins). No CRDT.

## UI

`PresenceLayer` renders inside React Flow's `<ViewportPortal>`, so cursors sit in flow
coordinates and the CSS transform handles zoom/pan. Peers live in a transient zustand store
(`src/renderer/state/presence.ts`, never persisted) that **only `PresenceLayer` subscribes to** —
following the existing `viewportRef` + rAF pattern (`Canvas.tsx:162`). If cursor traffic were to
re-render `Canvas`, every mouse move would redraw a 4000-line component.

- **Cursor** — arrow in the peer's color with a name label. Incoming positions arrive at 20 Hz
  and are lerped between frames. Your own cursor is never drawn.
- **Cursor chat** — `/` opens an input beside your cursor, broadcasts on every keystroke, and
  fades ~5 s after Enter/Esc. **Gotcha:** `/` must not open chat while you are typing in a
  terminal — the key only fires when the event target is the canvas pane, not xterm / Monaco /
  an input, matching the command palette's existing guard.
- **Facepile** (top right) — who is connected, in their colors. Cursorless peers (phones) appear
  here with a phone icon, since this is their only surface. Clicking an avatar centers the
  viewport on that peer's focused node.
- **Node header** — avatar chips for peers focused on the node, with a pulsing ring while they
  type. Reuses the `agentStatus` badge machinery (per-node badges from a transient store).

## Surfaces

- **Server Edition** — the primary stage; full feature.
- **Desktop (Electron)** — presence is silent when alone (≤1 peer draws nothing, zero cost).
  Acting as a relay host, the desktop shows the full peer list.
- **Mobile (nodeterm-ios, separate repo)** — a phone joins over the relay as a `HostSession`, so
  `hub.join()` fires for it today; it appears as a cursorless peer named "Phone" until it sends
  `presence:hello`. Typing attribution already works for it (see above). **Follow-up task in
  that repo:** send `presence:hello` + `presence:focus`, and render received cursor chat as a
  banner (it has no cursor to anchor a bubble to). Mobile does not *send* cursor chat in v1.

## Non-goals (v1)

Roles/permissions, follow/spotlight mode, persistent chat history, comment threads, write
locking, CRDT, character-level cursors inside editor/diff nodes (node-level focus only),
read-only guests, per-user settings.

## Testing

- `PresenceHub` pure unit tests: join / leave / diff, cursorless peer.
- Server e2e with **two** WS clients: hello → snapshot, cursor fan-out, echo suppression, leave
  on disconnect.
- Co-attach: two clients, one `persistKey` → a single spawn; both receive output; min-size
  resize; one client's backpressure does not stall the other.
- Canvas convergence: interleaved mutations from two clients → identical node sets.
- **Single-client regression:** min-size equals your own size and the spawn path is unchanged.

## Known risks

- **Weak identity** — anyone can claim any name.
- **Concurrent typing garbles input** — accepted; the badge is the warning.
- **Cross-user undo** — last-write-wins, no CRDT.
- **Cursor traffic** is 20 Hz × peers: comfortable for a 5–10 person team, not for a public room.
