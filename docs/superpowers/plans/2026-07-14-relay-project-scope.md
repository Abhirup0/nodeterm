# Plan: project-scoped relay sharing

**Branch:** `feat/relay-project-scope` (worktree `/root/nodeterm-projscope`, off `main` @ 88da9e6)

## Problem

A relay tab connects but shows an **empty canvas**. `openRelayTab` creates an empty
`addProject(label)`, and `canvas-sync.ts` is "a pipe, not a store" — it relays *future*
mutations but never sends the peer the host's *existing* nodes. So B sees nothing.

## Decision (user)

**A picks ONE project to share when it starts hosting; B sees only that project**, populated
with A's actual nodes, kept live by the existing Stage-3 mutation sync. Not a security boundary
(full trust — B already has shell access), but the intended UX: "I'm opening *this* project to you."

## Architecture (why each piece lands where it does)

- **The scope lives on the host relay session**, not in the offer. The offer/pairing code is
  unchanged — no project name leaks into a code that may be pasted around, and the pairing token
  stays single-purpose. `relayHost.start(projectId)` threads the id to `connectRelayHost`, held as
  `sharedProjectId` on the session.
- **Scoped serve happens at the relay boundary** (`relay-host.ts` dispatch), NOT in the core. The
  peer's `workspace:load` req hits the generic `platform.dispatch` (→ the `workspace:load` handler
  at `workspace-store.ts:65`, unchanged). We intercept the *response* for that one method when
  `sharedProjectId` is set and filter `projects` to just the shared one. The core stays generic;
  the "this peer sees one project" policy lives exactly where the peer boundary is.
- **The client populates the tab from the host's workspace.** After approval, `openRelayTab` calls
  `api.workspace.load()` (bridged → host, already scoped to the one project) and creates the tab
  bound to the relay session **with the host's nodes** (via `adoptProject` — fresh project id,
  node ids kept). Stage-3 sync then keeps it live.
- **The client never persists a relay tab.** A runtime-only `project.remote` flag (mirroring how
  `unavailable` is stripped in `workspace-files.ts`) excludes the whole entry from `toWorkspace()`.
  This also closes the T10 regression note: relay canvases must not land in B's `workspace.json`.
  (The per-node `data.remote` was deleted in T10; this is the correct project-level replacement.)

Sharing is **fixed for the hosting session** (change project = stop + restart hosting). v1 scope.

## Tasks (subagent-driven, TDD, review each)

### Task 1 — Host: thread `sharedProjectId` through start → session
- `src/shared/ipc.ts` / preload `relayHost.start`: `start(projectId?: string)` → send it with
  `relay:host:start`.
- `relay-host-service.ts` `initRelayHost`: the `relay:host:start` handler takes `projectId`, passes
  it to `connect({ ..., sharedProjectId: projectId })`.
- `relay-host.ts` `ConnectRelayHostOptions`: add `sharedProjectId?: string`; hold it on the session
  (expose `sharedProjectId()` or keep in closure for Task 2).
- Test: `relay-host-service.test.ts` — `start('proj-1')` passes `sharedProjectId:'proj-1'` to the
  injected `connect`. Preload/ipc are typecheck-only.

### Task 2 — Host: scope the `workspace:load` response to the shared project
- `relay-host.ts` dispatch (~:205): when `m.method === IPC.workspaceLoad` AND `sharedProjectId` is
  set, after `platform.dispatch` resolves, transform `res.result` (a `Workspace`) → keep only the
  project whose `id === sharedProjectId`, set `activeProjectId` to it; if it's gone, empty list.
  All other methods pass through untouched. Extract the filter as a pure helper
  (`scopeWorkspaceToProject(ws, projectId)` in `src/shared/`) so it's unit-testable.
- Test: pure helper — full workspace → one project, activeProjectId set, missing id → empty.
- Test: `relay-host.test.ts` — a `workspace:load` req over a session with `sharedProjectId` returns
  only that project; a `git:status` req is unaffected; no `sharedProjectId` → full workspace.
- **Security note for review:** this is UX scope, not a trust boundary. Confirm it does not *widen*
  anything (a peer still can't reach a method it couldn't before) and that a peer with no
  `sharedProjectId` behaves exactly as today.

### Task 3 — Host UI: pick the project when starting to host
- `RemoteAccessDialog.tsx` + `RemoteSection.tsx`: before `relayHost.start()`, choose which project
  to share — default the **active** project; a small select of open (non-closed) projects. Pass its
  id to `start(projectId)`. Label the offer/host state with the project name.
- Reads projects from `useProjects`. Keep the copy honest: "Sharing **<project>** — the joiner will
  see this project and can run commands on this Mac."
- Test: a pure view-model if one falls out (e.g. `hostShareOptions(projects) → {id,name}[]` default
  active first); else typecheck + the existing dialog tests stay green.

### Task 4 — Client: populate the relay tab from the host workspace
- `relay-tab.ts` `openRelayTab`: after `raceApproval`, `const ws = await handle.api.workspace.load()`
  → take `ws.projects[0]` (the scoped single project; guard empty → fall back to an empty tab with
  the label). Create the tab via a new dep `adoptProject(project)` (→ `useProjects.adoptProject`,
  fresh id, keeps node ids) instead of `addProject(label)`; mark it `remote:true` (Task 5). Bind the
  relay session to the adopted project's id; set active.
- The Canvas active-project effect already loads `project.nodes` into React Flow, and Task-6's
  `SessionProvider key={session.id}` already routes those nodes' transport to the relay api — so the
  adopted nodes' terminals co-attach to the host. Verify no extra wiring needed.
- Test: `relay-tab.test.ts` — `openRelayTab` with a fake api whose `workspace.load()` returns a
  one-project workspace calls `adoptProject` with that project (nodes intact) and binds the session
  to it; empty workspace → falls back to a labelled empty tab (no throw).

### Task 5 — Client: never persist a relay tab
- `src/shared/types.ts` `Project`: add runtime-only `remote?: boolean` (doc it like `unavailable`).
- `workspace-files.ts`: strip/skip a `remote` project entirely from the fanned-out index (it is a
  live connection, not a workspace on this disk) — mirror the `unavailable` handling, but SKIP the
  whole entry rather than inline it.
- `projects.ts` `toWorkspace`: exclude `remote` projects (and confirm the tripwire test still holds
  — no runtime field is serialized).
- Test: `projects.test.ts` — a `remote:true` project is absent from `toWorkspace()`; a normal one
  survives. `workspace-files` test — a `remote` entry produces no index ref / inline entry.

### Task 6 — Gate + docs
- `npm run typecheck` + full `npx vitest run` green.
- `docs/remote-sessions.md`: flip the "relay-tab canvas population" follow-up to landed; document
  project-scoped sharing (host picks one project, held on the session, scoped serve at the relay
  boundary, client adopts + never persists). Note the fixed-per-session limitation.
- Two-instance manual check appended: A shares project X → B sees X's nodes, edits sync both ways,
  B's other-project access is not offered.

## Merge gate
Crypto/carrier gate unchanged (this adds no crypto); full suite green; whole-diff review with a
security pass on Task 2 (scope doesn't widen access); then merge to main.
