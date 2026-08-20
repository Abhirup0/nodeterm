# Probe — S6 PR 6 remote leg (U6, U7) on a live SSH host

**Date:** 2026-08-19 · **Host:** niova (Linux, x86_64) · **Transport:** real `ssh`/`scp` to
`localhost` over a dedicated ed25519 key, scratch `CODEX_HOME` under `$HOME`, never touching any
other user's live nodeterm/codex state. **Codex:** `codex-cli 0.146.0` (`/usr/bin/codex`,
npm-managed at `/usr/lib/node_modules/@openai/codex`). **Node:** v22.22.2 (`/usr/bin/node`).
`curl` present. All three resolve through `readlink -f`, which is the gate
`installRemoteCodexRuntime` requires.

The uploaded relay is an esbuild standalone bundle of `src/main/codex-relay-daemon.ts` (ws bundled
in, CJS, node22) — the exact artifact `scripts/build-codex-relay.mjs` produces and
`codexRelaySource()` uploads. 176 KB, parses and runs under the host's own `node`.

## U6 — the uploaded relay launches and answers over the host's own Node — VERIFIED

Ran each subcommand as `node ~/.nodeterm-.../codex-relay.js <cmd>` **over SSH** (the remote host's
own node, not the local process):

| Subcommand | Target | Result |
| --- | --- | --- |
| `account-read <sock>` | a LIVE `codex app-server --listen unix://<sock>` (0.146.0) | `{"email":null}`, exit 0 — full `initialize`→`initialized`→`account/read` round-trip against a real app-server; `null` because that scratch home is not logged in (fail-closed, not a fabricated identity) |
| `thread-check <sock> <id>` | fake app-server returning that thread | exit 0 |
| `thread-check <sock> <missing>` | live app-server / fake without the thread | exit 69 (fail-closed) |
| `expose-thread <sock> <id> <sock>` | target already holds the thread natively | exit 0 (native early return) |
| `expose-thread <sock> <ghost> <sock>` | thread absent across every catalog | exit 69 (ambiguous/unavailable ⇒ REFUSE) |

`serve`/`register` self-spawn was already proven runnable under plain `node` by the merged
child-process test (`codex-relay-daemon.test.ts`); this probe adds the missing leg — the **uploaded
bundle** running under the **remote host's own node over a real SSH transport**.

### Load-bearing correction to the Task 4.0 record

Task 4.0 recorded the app-server as "NOT runnable headless … needs the curl-managed standalone
install." That is only true of `codex app-server daemon start` (which refuses without
`<CODEX_HOME>/packages/standalone/current/codex`). The **fallback path** —
`codex app-server --listen "unix://<sock>"` — **binds the control socket on a plain npm install**,
which is exactly the branch `remoteCodexAppServerStartCommand` takes after `daemon start` fails. So
the remote account/app-server leg is live-runnable on an ordinary `npm i -g @openai/codex` host, not
only on a standalone install. The `account/read`→`{email}` and `thread/read`→`{path,cwd}` RPC shapes
are confirmed against a real 0.146.0 app-server (U4, previously headless-unverified, now verified for
the `--listen` path).

## U7 — home layout `dirname(dirname(socket)) === home`, sibling `sessions/` — VERIFIED

- A real logged-in `/root/.codex` install: control socket at
  `/root/.codex/app-server-control/app-server-control.sock` ⇒ `dirname(dirname(socket)) ===
  /root/.codex === CODEX_HOME`. Sibling `sessions/` present, holding rollouts at
  `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` — the exact `sessions/<rel>` shape
  `remoteCodexImportThread` validates and the traversal guard confines writes under.
- `codex app-server daemon version` against a fresh scratch home reports the same
  `<CODEX_HOME>/app-server-control/app-server-control.sock` path, and `--listen` binds precisely
  there. `auth.json` is a real `0600` file (identity gate: `test -f && test ! -L`).
- Note: `sessions/` only materialises once a conversation exists; the import path `mkdir -p`s the
  dated target dir before the atomic `mv`, so a brand-new account home is handled.

## Owed device-verification (not blocking)

- U1 (running app-server surfaces a freshly `mv`d rollout without a reindex) and U2 (conversation id
  survives copy+switch under a second login) still need a logged-in second account + a live daemon —
  the atomic import's verify-before-recycle (`remoteCodexThreadExists` after install, rollback on
  miss) degrades a false U1 to a refused copy, never a silent one.
- The full desktop→host account add / device-login / import against a **standalone** install over a
  real WAN link (not loopback) is owed on a Mac + a real remote host.
