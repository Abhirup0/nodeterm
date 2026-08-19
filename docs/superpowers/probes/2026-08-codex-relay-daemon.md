# Probe — the shared Codex relay daemon (S6 PR 4: U1, U2, U4, U6)

**Design claims under test:** the four `[UNVERIFIED]` assumptions the shared relay daemon
(`src/main/codex-relay-daemon.ts`) and the cross-machine rollout copy rest on (S6-spec §7). Run
first, before the daemon was built on them; recorded here and in the daemon's header comment.

## Environment

- **Codex CLI 0.146.0** (`/usr/bin/codex`, npm-managed). Linux, headless. System `~/.codex` is logged
  in (`~/.codex/auth.json`, `0600`) and holds real rollouts under `~/.codex/sessions/YYYY/MM/DD/`.
- **No running app-server and no curl-managed standalone install** on this host:
  `~/.codex/app-server-control/` has only a `app-server-startup.lock`, no `.sock`; there is no
  `~/.codex/packages/standalone/current/codex`. This is the documented U4 caveat and it bounds what
  U1/U2 could be measured directly (see below) — the same limitation the U5 probe hit.
- Node 22.22.2. The relay's own runnable behaviour is exercised by
  `src/main/codex-relay-daemon.test.ts` (30 tests) against real fs / real unix-socket fake
  app-servers.

## U4 — Codex app-server subcommands and flags exist as used — **PARTIAL / VERIFIED**

Measured against the real CLI:

- `codex app-server daemon` exposes `start | restart | stop | version | bootstrap |
  enable-remote-control | disable-remote-control`. `CODEX_HOME` is honoured: `daemon start` created
  `<CODEX_HOME>/app-server-daemon/{app-server.pid.lock,daemon.lock}`, and `daemon version` returned
  JSON reporting `socketPath = <CODEX_HOME>/app-server-control/app-server-control.sock` (confirming
  the socket layout the daemon assumes: `dirname(dirname(socket)) === CODEX_HOME`, sibling
  `sessions/` — U7 corollary, confirmed against the real `~/.codex` tree).
- **The `SUN_LEN` constraint is REAL.** With a long scratch `CODEX_HOME`, `daemon version` failed to
  connect: `path must be shorter than SUN_LEN`. This is exactly why the managed home digest is short
  (S6-spec §2.1) — measured, not assumed.
- `--remote <ADDR>` and `--remote-auth-token-env <ENV_VAR>` exist on the global command and on
  `resume`/`fork`. The remote bearer token is named by **env var**, never passed on argv (GC 6).
- Rollout filenames are `rollout-<timestamp>-<UUID>.jsonl` where the UUID is the thread id
  (`session_meta.session_id`), so PR 3's `planCodexRolloutExposure` filename check
  (`basename.endsWith("<threadId>.jsonl")`) holds against real rollouts.

**Not runnable headless:** `daemon start` actually binding a live socket, and the
`account/read`→`{email}` / `thread/read`→`{path,cwd}` RPC shapes, require the curl-managed standalone
install absent here (`daemon start` errored: *"managed standalone Codex install not found at
…/packages/standalone/current/codex"*). The relay speaks those shapes to **fake** app-servers in the
suite; a live-shape check is **owed device-verification** on a box with the standalone install.

**Verdict: NOT BLOCKED** — the subcommand/flag surface the daemon depends on exists as used; the RPC
payload shapes are the only unmeasured part and are covered by the design's fail-closed verify step.

## U1 — a RUNNING app-server surfaces a freshly hardlinked rollout without a reindex — **UNVERIFIED (headless), NOT BLOCKING**

Could not be measured: no running app-server and no standalone install to start one, so whether
`thread/read` (and the merged `thread/list` picker) surfaces a just-hardlinked
`sessions/…/rollout-…jsonl` without rebuilding an index is unproven here.

**Why it does not block, and how the design self-protects:** the cross-machine copy does **not** trust
the optimistic answer. `exposeForeignThread` links the rollout via PR 3's primitive and then RE-READS
the **target** socket (`thread-check` = `thread/read`); it returns `exposed` only if the far side
reports that exact id with an absolute path/cwd, and otherwise **rolls the published link back and
refuses** (proven by *"rolls the published link back when the target app-server cannot discover the
copy"*). So if U1 is false in practice, the copy degrades to a *refused* copy — never a silent switch
onto a host that cannot see the conversation. If a device check finds a reindex IS required, the fix
is local: trigger it before the verify read; the fail-closed contract is unchanged. **Owed
device-verification** with the standalone install + auth.

## U2 — the conversation id survives copy + account switch — **UNVERIFIED (headless), NOT BLOCKING**

Could not be measured: needs auth, a second managed login, and a running daemon to actually
`resume <id>` a copied rollout under a different account and observe the returned `thread.id`.

**Why it does not block:** the copy is a **hardlink of the exact source inode**, so the on-disk
conversation id is byte-identical; the relay resumes **by rollout path** with `params.history`
deleted (Codex resume precedence history > path > id, `retargetRelayResumeByPath`). If Codex
nonetheless forks the id under the new login, `resolveRelayThreadResponse` flags `unexpectedThreadId`
and the reply is rewritten to error `-32004 "Codex changed the conversation id during account
switch"` (proven by *"rejects a path-resume response that changes the conversation id"*). A false U2
therefore surfaces as a refused switch, never a silent fork. **Owed device-verification.**

## U6 — relay self-spawn — **LOCAL LEG VERIFIED (runnable); REMOTE LEG owed**

The daemon self-execs `spawn(process.execPath, [__filename, 'serve'], { env: {
ELECTRON_RUN_AS_NODE: '1', … } })` and dispatches on `process.argv[2]`
(`serve|register|account-read|thread-check|expose-thread`).

- **Runnable, verified:** the suite bundles the TS daemon to CJS (esbuild) and runs it under plain
  `node`: `register` self-spawns `serve`, which binds a loopback-TCP control port, writes its `0600`
  state file, and answers a real `/register` round-trip returning `ws://127.0.0.1:<port>` + a route
  key (*"sources the node token from env, never argv, and mints a header-only control token"*). In
  Electron main `process.execPath` is the Electron binary and `ELECTRON_RUN_AS_NODE=1` runs it as
  Node — the standard NodeTerm self-spawn idiom.
- **Owed device-verification:** the REMOTE leg — the uploaded `~/.nodeterm/bin/codex-relay.js` run
  via the `nodeterm-codex` launcher over the host's own Node, answering
  `register`/`thread-check`/`expose-thread` — needs a live SSH host and is not exercised here.

**Verdict: NOT BLOCKED.**

## Note observed while probing (not a probe target)

`ensureServer` acquires its control lock *inside* `~/.nodeterm` but does not itself create that root
(only `serve()` does), so the very first `register` on a machine whose `~/.nodeterm` does not yet
exist cannot self-spawn the server. In production `~/.nodeterm` already exists (node-auth secret,
mappings, …); flagged for PR 5's live wiring to ensure the root is created before first relay use.
