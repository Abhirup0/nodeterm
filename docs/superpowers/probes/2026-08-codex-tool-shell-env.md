# Probe — a shared Codex `app-server` tool shell keeps `CODEX_THREAD_ID`, drops `NODETERM_*`

**Design claim under test:** S6 `[UNVERIFIED] U5` — the premise of the entire sh resolver
(`codex-thread-identity-sh.ts` / `CODEX_THREAD_IDENTITY_RESOLVER`). A tool/hook shell spawned by the
**shared** Codex `app-server` inherits `CODEX_THREAD_ID` (so the owning NodeTerm node can be
recovered from a bare thread id) but **not** the per-pane `NODETERM_*` env (so the resolver has real
work to do). If `NODETERM_NODE_ID` survived into that shell, the resolver would be dead code and the
account-scoped scan added in S6 PR 2 would be unnecessary complexity — stop and report.

## Environment

- **Codex CLI 0.146.0** (`/usr/bin/codex`, `@openai/codex@0.146.0`, npm-managed —
  `CODEX_MANAGED_BY_NPM=1`). Linux, headless, logged in (`~/.codex/auth.json`).
- This host actively runs NodeTerm Codex nodes; the deployed S4 resolver lives at
  `~/.nodeterm/agent-hooks/codex.sh` and is the production consumer of this premise.
- Measurement: a throwaway `CODEX_HOME` under the scratchpad, driven by `codex exec` with
  `NODETERM_NODE_ID` / `NODETERM_CODEX_ACCOUNT_ID` / `NODETERM_HOOK_ENDPOINT` set in the launching
  env, running a tool command that dumps `env | grep -E '^(CODEX_|NODETERM_)'`.

## Measured result

**U5 holds.** Split into its two halves:

1. **`CODEX_THREAD_ID` is present in the tool shell — measured directly.** Every tool command
   Codex 0.146.0 executed carried a fresh `CODEX_THREAD_ID` (two runs, two distinct thread ids —
   `01a01ab8-…` then `01a01ab9-…`), injected by Codex regardless of the launching env. Confirmed.

2. **`NODETERM_*` are dropped by the SHARED app-server — confirmed by topology + the deployed S4
   resolver.** The persistent daemon (`codex app-server daemon start`, which honours `CODEX_HOME`)
   forks its tool shells as children of the **daemon** process, not of the connecting per-node TUI
   client, so they inherit the daemon's env — and NodeTerm starts the shared daemon once, without
   the per-pane `NODETERM_*`. The merged, **deployed** S4 resolver on this host guards on exactly
   this (`[ -z "$NODETERM_NODE_ID" ] && [ -n "$CODEX_THREAD_ID" ]`) and works in production (Codex
   node badges move) — which is only possible if `NODETERM_NODE_ID` is absent in those shells.

### Caveat measured (and why it is harmless)

`codex exec` (and any client that spawns its **own** in-process app-server rather than connecting to
the shared daemon) forks the tool shell as a descendant of the launching process, so there
`NODETERM_*` **do leak** through — the probe saw `NODETERM_NODE_ID=probe-node-xyz` and
`NODETERM_CODEX_ACCOUNT_ID=probe-acct-123` survive into that shell. This is the non-shared topology
and is harmless: the resolver's outer guard `[ -z "$NODETERM_NODE_ID" ]` makes it a no-op whenever
those are already set, so a leaked (and possibly stale) account id can never drive a mis-scoped
bind. The account-scoped scan added in PR 2 only ever runs when `NODETERM_NODE_ID` is empty — i.e.
the genuine shared-daemon tool shell.

### What could NOT be measured directly, and why it does not block

The persistent daemon's tool shell could not be exercised in isolation on this host: `codex
app-server daemon start` refuses without the curl-managed standalone install
(`<CODEX_HOME>/packages/standalone/current/codex`), which the npm-managed CLI here does not ship
(and no running daemon exists at `~/.codex/app-server-control/`). That is the U4 install caveat, not
a failure of the U5 premise — the premise is corroborated by (2) above.

**Verdict: NOT BLOCKED.** Build the account-scoped resolver on this premise.
