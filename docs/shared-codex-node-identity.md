# Shared Codex node identity — the account-scoped ownership spine

A Codex canvas node talks to **one shared `codex app-server`** and owns **one thread** inside it.
The node↔thread mapping is what survives resumes, in-pane restarts, and app restarts. S6 adds the
**account** dimension: the same machine can hold the system login (`~/.codex`) alongside several
managed logins, and a thread's ownership record must name **which account** it belongs to, not just
which node — so one account can never be made to speak for another's threads.

This document covers the ownership spine shipped in S6 PR 2. The account **model** and on-disk home
layout are PR 1 (`codex-accounts-core.ts`); the spawn wiring, relay, and switch/transfer protocol
are later PRs. This slice **ships inert** — nothing sets `NODETERM_CODEX_ACCOUNT_ID` on a pane yet —
but it is fully tested against real primitives (real `/bin/sh`, real fs, real HMAC).

## The signing secret (both shells — Decision 1)

Every ownership record is HMAC-signed by the **one** restart-stable 32-byte node-auth secret
(`src/core/agents/node-auth-secret.ts`, `loadOrCreateNodeAuthSecret`). That secret already arms on
**both** shells and this proxy reuses it as-is:

- **Desktop:** sealed at rest via `safeStorage` → `node-auth-key.json` (ciphertext only, mode
  `0600`; no raw-secret fallback ever written).
- **Server Edition (no keychain):** 32 raw bytes at `node-auth-key.bin`, mode `0600`.

It is **confidential and fail-closed**: a malformed/wrong-length persisted state **throws** rather
than minting a fresh secret — rotating the key would orphan every bound thread on the machine — and
the single-flight cache clears on rejection so a healed machine retries. It is wired at boot in both
`src/main/index.ts` and `src/server/index.ts` via `setCodexThreadIdentityAuthSecret(...)`.

> No `safeStorage`-only secret module is introduced. @Corvin's `codex-node-auth-secret.ts` in
> PR #112 is `safeStorage`-ciphertext-only and throws on a headless server; the merged both-shells
> channel above is the correct mirror, and duplicating it as a keychain-only file would regress the
> Server Edition. This is the ratified Decision 1.

## The ownership records

`~/.nodeterm/codex-thread-nodes/` (under `CorePlatform.userDataDir`, **not** `~`):

- **System account** → the bare-root file `<root>/<threadId>` — the exact S4 layout, so a machine
  with no managed accounts is byte-for-byte unchanged and its legacy records keep resolving.
- **Managed account** → `<root>/<accountId>/<threadId>`.

Each record is a flat `key=value` text file, mode `0600`, **parsed as data, never sourced**:

```
accountId=<id or empty for system>
nodeId=<owning canvas node>
endpoint=<hook endpoint file path>
signature=<base64url HMAC>
```

### The signature binds the full 4-tuple

```
signature = base64url( HMAC-SHA256( key, threadId ␀ accountScope ␀ nodeId ␀ hookEndpoint ) )
```

`accountScope` is the account id, or the literal `system` for the system account (empty id
normalised). Because the scope is inside the preimage, a record signed for account **A** verifies
only under scope **A** — copying it byte-for-byte into account **B**'s directory fails the MAC.
Verification is `timingSafeEqual`. Records written before this slice carry **no** `accountId=` line
and are verified with the original 3-tuple preimage **at the system scope only** — the one
back-compat door, and it is a system-scope door (a scope-less signature is never honoured under a
managed account).

## Fail-closed ambiguity (the house rule, reused)

Ownership resolution reuses the merged fail-closed posture (`pane-ownership.ts`,
`node-identity-policy.ts`): **an owner that cannot be proven is denied.**

- `resolveCodexThreadNodeIdentity(threadId)` with no account hint (the shared tool shell that knows
  only a bare thread id) scans **every** scope and returns an owner **only when `owners.size === 1`**.
  The same thread id owned by two different accounts resolves to **nothing**.
- `resolveCodexThreadNodeIdentity(threadId, root, accountId)` with an explicit account resolves
  within that one scope.
- `codexThreadIdentityHasLiveConflict(...)` reports a conflict only when **two different live
  nodes** own the thread across scopes.

## The POSIX-sh resolver

`codexThreadIdentityResolverSh(root)` is prepended to every managed hook script. A shared-app-server
tool shell inherits `CODEX_THREAD_ID` but not the pane's `NODETERM_*` (see probe U5,
`docs/superpowers/probes/2026-08-codex-tool-shell-env.md`), so this prelude recovers the binding:

- reads `NODETERM_CODEX_ACCOUNT_ID` from the daemon env to pick the scope;
- a known safe account id ⇒ reads **only** that account's record, and requires the record's
  `accountId=` line to **agree with the daemon scope**;
- an **empty** account id ⇒ scans every scope (bare-root system + each managed subdir) and binds
  **only when exactly one candidate matches** (`nt_codex_matches -eq 1`) — two accounts holding the
  same thread id change nothing;
- it cannot verify the HMAC (no key in an agent's shell), so it re-validates every recovered field's
  charset and the account-line/scope agreement before exporting. Its behaviour is proven under real
  `/bin/sh` against a real on-disk scope tree in `codex-thread-identity-sh.test.ts`.

## Supply-chain guard

Account ids arrive from hand-editable `settings.json` / `project.json`. Every id passes
`ACCOUNT_ID_RE` (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, must start alphanumeric) — via `accountScope()` in
the proxy, the launcher's own sh check, and the hook-server route — **before** it becomes a
directory scope, so `.`/`..`/leading-separator/`a/b`/absolute ids are refused at the door. The
launcher threads the account id through the `/codex-thread/{start,bind}` POST **body**, never on
argv (Constraint 6); a bad id falls back to plain `codex` rather than binding under a hostile scope,
and the server refuses it at `400` before the start handler can create an orphan thread.
