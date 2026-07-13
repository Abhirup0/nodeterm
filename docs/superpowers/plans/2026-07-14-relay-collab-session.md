# Plan: session-aware live collaboration (presence + canvas-sync over a relay tab)

**Branch:** `feat/relay-collab-session` (worktree `/root/nodeterm-collab`, off `main`)

## Problem (root cause — confirmed in code via systematic debugging)

A relay tab now POPULATES (project-scope landed), but live collaboration doesn't cross the tunnel:
B sees no cursors/facepile, and a terminal B opens never appears on A. Both symptoms share ONE
root cause: **Canvas's live-collaboration layer is bound to the LOCAL session, never the active one.**

Two binding mechanisms, both mount-fixed to local:
1. **Static module imports** — `connectPresence` / `usePresence` / `reportProject` / `reportFocus`
   (Canvas.tsx:86, and the presence-reading components) resolve to `defaultPresence` = the
   `window.nodeTerminal` (LOCAL) `PresenceSession` (presence.ts:599-603).
2. **Effect dep arrays omit the active-session `api`** — `connectPresence()` `[]` (Canvas.tsx:3898),
   the `canvas:mut` publisher `[]` (1330), the `onMutation` subscriber `[setNodes, markDirty,
   publishableNow]` (1416). All capture the mount-time (local) `api` and never re-bind on tab switch.

Consequences:
- **No peer cursors/facepile:** cursor write + presence rendering use the LOCAL store; on a relay tab
  nothing publishes to / reads from the relay session's presence.
- **B's new terminals don't reach A:** the publisher's `api.canvas.mutate` is the mount-time LOCAL
  api (publishes to B's own core, not the relay), AND the publish gate `hasPeersRef` reads the LOCAL
  presence peer count (no peers → never publishes). `onMutation` is likewise bound to the local core.

This is the documented 4c follow-up ("top-level Canvas api is still the local session") — the
POPULATION path (active-project effect + per-node transport via `useSession`) re-binds correctly;
the live COLLABORATION path does not.

## Design

Route the whole collaboration layer through the ACTIVE session's `PresenceSession` +
`api.canvas`, re-bound when the active session changes. The seam already exists:
`getSessionStores(sessionId).presence` returns the per-session `PresenceSession`, and `useSession()`
gives the active session `{ id, api, source }`.

- **New hook** `useActiveSessionPresence(): PresenceSession` = `getSessionStores(useSession().id).presence`
  (memoized by session id). For a LOCAL tab this returns `defaultPresence` (the exact object the ~40
  historical imports use — verified by the WeakMap memo seeding `window.nodeTerminal → defaultPresence`),
  so **local behavior is byte-identical**; for a relay tab it returns the relay session's presence.
- **Canvas** (the trickiest file — preserve its documented invariants):
  - Re-key the three mount-bound effects on `session.id` (so they tear down + re-bind on tab switch):
    `connect()`, the publisher, the `onMutation` subscriber, and `reportProject`.
  - The publisher must use the ACTIVE session's `api.canvas.mutate` and gate on the ACTIVE session's
    presence peer count (`presence.store.getState()` — read imperatively, NOT reactively).
  - **PERF CONTRACT (docs/team-presence.md):** Canvas must NOT re-render on 20 Hz cursor frames — it
    reads presence via `store.getState()` / `store.subscribe`, never the reactive `usePresence(sel)`
    hook. Preserve exactly.
  - **Order-state invariant:** the `onMutation` order/reconnect state must survive a tab switch. On a
    LOCAL tab the active-session api IS the local api, so re-keying on `session.id` is a no-op for the
    local→local case (same api, same subscription) — background local projects keep working. On a
    relay tab the subscription is the relay core's. Confirm the re-key doesn't drop mutations for a
    background LOCAL project while a relay tab is active (nobody edits your local core remotely, so
    swapping is acceptable — but verify no crash / no lost local edit).
- **Presence-reading components** (`Facepile`, `PresenceChips`, `PresenceLayer`, `PresenceNamePrompt`)
  and the **cursor/chat WRITE** (`PresenceLayer` → `api.presence.cursor`/`chat`): read/write the
  ACTIVE session's presence + api, not the static default. They render under the Canvas
  `SessionProvider` (keyed by session.id), so `useSession()` / `useActiveSessionPresence()` resolve
  the right one. Preserve their reactive subscription (they ARE allowed to subscribe; Canvas is not).

## Tasks (subagent-driven, TDD, review each — HIGHER RISK: trickiest file + perf contract)

### Task 1 — `useActiveSessionPresence` hook + confirm the provider tree
- Add `useActiveSessionPresence()` to `src/renderer/session/session.ts` (or a small hook file):
  `getSessionStores(useSession().id).presence`. Also a non-hook `activeSessionPresence()` if Canvas
  needs it outside render.
- Confirm `Facepile`/`PresenceChips`/`PresenceLayer`/`PresenceNamePrompt` render UNDER the
  `SessionProvider` (Canvas subtree). If any renders OUTSIDE it (e.g. a top-level facepile), note it —
  it must be moved under, or take the session another way.
- Test: the hook returns the local session's presence for a local session and a distinct instance for
  a relay session (unit test against the session registry with two fake apis).

### Task 2 — Presence-reading components + cursor/chat write → active session
- `Facepile`, `PresenceChips`, `PresenceLayer`, `PresenceNamePrompt`: replace the static `usePresence`
  / default-session reads with `useActiveSessionPresence().store(selector)` and the session's
  selectors. `PresenceLayer`'s cursor + chat WRITE uses `useSession().api.presence`.
- Preserve the reactive-subscription perf shape (they still subscribe; only the SOURCE store changes).
- Test: a component reading a fake relay session's presence shows that session's peers; local
  unchanged. (If jsdom-render is unavailable, extract the store-selection into a testable seam.)

### Task 3 — Canvas presence effects session-aware (connect + reportProject/reportFocus)
- Re-key `connectPresence()` (3898) and `reportProject` (1013) on `session.id`: `useEffect(() =>
  presence.connect(), [presence])` where `presence = useActiveSessionPresence()`; `reportProject`
  calls the active session's. `reportFocus`/`releaseFocus` likewise.
- Local tab: `presence === defaultPresence`, so the effect re-runs once at mount with the same object
  — byte-identical. Relay tab: connects the relay presence (sends hello + cursors over the tunnel).
- Test: switching the active session re-runs connect on the new session's presence and tears down the
  old (spy on connect/teardown).

### Task 4 — Canvas canvas-sync session-aware (publisher + onMutation + hasPeers) — the riskiest
- Re-key the publisher effect (1283-1330) and the `onMutation` effect (1377-1416) on `session.id` (add
  `api`/`presence` to deps). The publisher uses the ACTIVE `api.canvas.mutate`; `hasPeersRef` reads the
  ACTIVE presence peer count. `onMutation` subscribes the ACTIVE `api.canvas`.
- PRESERVE: the PERF CONTRACT (no reactive presence read in Canvas), the order/reconnect state
  survival, the `disposeTerminalOnUnmount(sessionForProject(projectId).id, …)` calls (already
  session-scoped from project-scope), and the loadingRef adopt-not-publish suppression.
- Test: with a fake relay session active, a local node change publishes via the relay api and is gated
  ON when the relay presence reports a peer; an inbound relay mutation applies to the canvas. Local
  path unchanged. (Extract the publish-gate/emit into a testable seam if Canvas can't be rendered.)

### Task 5 — Gate + docs + acceptance
- `npm run typecheck` + full `npx vitest run` green.
- `docs/remote-sessions.md`: flip the collaboration follow-up to landed; document that presence +
  canvas-sync now follow the active session. Add to the two-instance checklist: B sees A's cursor and
  facepile; a terminal opened on EITHER side appears on the other; chat bubbles cross.

## Merge gate
No crypto/handshake file touched (confirm). Full suite + typecheck green. Whole-branch review with a
focus on: the perf contract intact (no new Canvas re-render on cursor frames), local behavior
byte-identical, and no dropped mutations across a tab switch. Then merge to main.
