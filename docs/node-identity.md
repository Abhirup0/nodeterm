# Per-node hook identity

Every agent session on a machine shares one hook bearer token. The bearer proves *"a session on
this machine"*; it cannot prove **which** session. Every hook route takes a caller-supplied
`nodeId`, so before per-node identity any session holding the bearer could post events as a
sibling node, read a sibling's linked transcript, or drive canvas control in its name.

Per-node identity closes that. Each node gets a capability derived from a restart-stable secret,
and each route decides what a missing or foreign one is worth.

## The credential

```
kid   = base64url(HMAC-SHA256(secret, "nt-node-auth-kid-v1"))[0..8]
mac   = base64url(HMAC-SHA256(secret, "nt-node-auth-v1|" + nodeId))
token = kid + "." + mac
```

Derived, not minted-and-stored: tmux sessions outlive the app, so a table built at spawn is empty
for every already-running session after a restart and cannot be rebuilt. A derivation lives exactly
as long as the secret.

It reaches a client as a 0600 file under `NODETERM_NODE_TOKEN_DIR/<nodeId>` (advertised in the
endpoint file), **never** as an environment variable — that channel put the credential on the tmux
`-e` argv, world-readable on a stock Linux.

| File | What it owns |
| --- | --- |
| `src/core/agents/node-auth-secret.ts` | The secret. safeStorage on the desktop, raw 0600 bytes on the Server Edition. |
| `src/core/agents/node-auth-token.ts` | The derivation, `verifyNodeToken`, `isSafeNodeId`. |
| `src/core/agents/node-token-files.ts` | The 0600 token files in their 0700 dir. |
| `src/core/agents/node-identity-policy.ts` | **What a token buys, per route.** |
| `src/core/agents/hook-server.ts` | The routes that apply it. |

## Three verdicts, not two

`verifyNodeToken` answers `verified`, `legacy` or `forged`.

- **`verified`** — the caller holds the token this instance derived for that node id.
- **`legacy`** — no token, an empty header, another instance's `kid`, or no secret at all. This is
  *"we cannot judge this"*, **not** a failure. Every client older than the token, the phone, and the
  documented cross-instance failover land here.
- **`forged`** — **our** `kid` with a mac that is not this node's. Nothing legitimate produces it.
  It is a 403 on every route, always, with no explanatory prose.

## Per-route policy

| Route | `legacy` |
| --- | --- |
| `/hook/*` | Always accepted, 204, listeners fired. The label is a label. |
| `/verify`, `/hook/verify` | Bearer alone, forever — no identity of any kind. |
| `/codex-thread/{start,bind}` | Refused. Strict from the day they existed; there is no upgrade population to protect. |
| `/codex-thread/fallback` | Accepted **when tokenless** (the commonest thing it reports is that there was no token); a report that carries one must carry the right one. |
| `/control/*`, `/context-link/*` | See below. |

### Trust on first proof

`hookServer` remembers, **in memory only**, every node that has presented a valid token for itself
(`provenNodes`). Once a node is in that set, an unverified request naming it is refused: the session
demonstrably *can* authenticate, so one that suddenly cannot is either a different process wearing
its node id or a forgery.

Two properties keep that from breaking anybody:

- **A foreign `kid` never proves a node and is never caught by the latch.** Another instance's token
  is the documented cross-instance failover, not an impostor.
- **The latch is never written to disk.** A restart re-earns it within one hook event, and a
  persisted latch is a node that one filesystem accident could brick forever.

### The dated window

Until **2026-10-13** (`NODE_IDENTITY_STRICT_AFTER`), an unverified *mutation* on `/control/*` still
**executes**, and the reply is prefixed with a sentence naming the fix and this date. On and after
that date the same situation is a refusal and the handler never runs.

The date is the owner's rule — *the second minor release or 60 days after the shipping release,
whichever is later* — resolved to a concrete instant. It lives in the source
(`node-identity-policy.ts`) as well as here, so "we'll tighten this later" is a commitment with a
date rather than a comment.

`list` sits in a **tolerant** bucket that stays open past the cutoff: it leaks the shape of the
canvas but changes nothing, and refusing it would leave a legacy client unable to orient itself at
all. Every `/context-link/*` verb is a read and sits in the same bucket.

`/context-link/*` refuses with **prose and a 200**, not a 403: the agent explicitly asked for a
read, and the shim turns any non-200 into "nodeterm unreachable" — a lie it can do nothing with.

`write` and `close` keep their **user confirmation** whatever the token says. A capability is not a
substitute for the human's answer, and neither verb is ever tolerant.

### The escape hatch

`settings.hookIdentityStrict` (absent by default):

| Value | Effect |
| --- | --- |
| absent | Follow `NODE_IDENTITY_STRICT_AFTER`. |
| `true` | Enforce now, before the date. |
| `false` | Keep the warning window open past the date **and** release the latch. |

`false` is for a user whose upgrade strands a live session: it gets the canvas back without
downgrading the app. Neither value ever admits a `forged` token.

## Ids are path segments

`isSafeNodeId` (node ids) and `isSafeThreadId` (codex thread ids) refuse `.`, `..`, empty and
over-length **on top of** the `[A-Za-z0-9._-]` charset, because both ids are used as path segments
— `<tokenDir>/<nodeId>`, `<codexThreadIdentityRoot>/<threadId>` — and `.` and `..` match that
charset. One predicate each, applied before the id reaches a path join or a hash. Do not add a
second copy of either rule; a rule with two copies is a rule where one copy is wrong.
