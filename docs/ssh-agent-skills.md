# nodeterm skills in SSH projects

How the agent-facing skills (`manage-nodeterm-canvas`, `get-linked-context`) reach an agent
that is running on a **remote host** in an SSH project.

## The problem

Both skills were installed only into the desktop's own home:

- `manage-nodeterm-canvas` → `~/.claude/skills/…` + `<userData>/canvas-control/`
- `get-linked-context` → `~/.claude/skills/…` + `<userData>/context-links/`

An SSH project's agent runs on the **host**, reads the **host's** `~/.claude/skills`, and finds
nothing. Copying the files over would not have helped either: both shims were generated as

```sh
ELECTRON_RUN_AS_NODE=1 exec "<the desktop's Electron binary>" "<…>/cli.mjs" "$@"
```

— a path that exists on exactly one machine. And the Node CLI they exec'd talked to the hook
server over `127.0.0.1:<port>`, which on the host is the host's own loopback, not the desktop's.

## The transport (already there)

Nothing new had to be invented: an SSH project already runs a **reverse unix-socket tunnel** from
the host back to the desktop's loopback hook server, because that is how remote agents report
status (`RemoteHooks.setup`, `docs/`-less but see `src/main/remote-ssh/remote-hooks.ts`):

```
remote agent → curl --unix-socket ~/.nodeterm/hook-<projectId>.sock
             → ssh -R → desktop 127.0.0.1:<hook port>
```

The per-project endpoint file `~/.nodeterm/hook-endpoint-<projectId>.env` carries the live
`NODETERM_HOOK_SOCK` / `_TOKEN` / `_VERSION`, and every remote session's tmux env already points
at it (`NODETERM_HOOK_ENDPOINT`) along with `NODETERM_NODE_ID`. So the design rule is:

> **The remote side is a thin client.** It ships no parsing, no state and no app knowledge — it
> POSTs over the existing tunnel and prints what comes back.

## What shipped: canvas control over SSH

1. **The CLI is now POSIX sh + curl** (`CONTROL_SHIM_SCRIPT` in `canvas-control-core.ts`),
   replacing the Electron-as-Node CLI. It carries **no machine-specific paths**, so the same
   script is installed on the desktop and on the host. It picks its transport from the endpoint
   it was given: `--unix-socket $NODETERM_HOOK_SOCK` when one is advertised (SSH), else
   `127.0.0.1:$NODETERM_HOOK_PORT` (desktop). `curl` is not a new dependency — the managed hook
   script already requires it.

   The request is **form-urlencoded**, not JSON: `curl --data-urlencode` is the only escaping sh
   can be trusted with. Values like `--prompt`, `--html` and `--team` routinely contain quotes,
   newlines and `$`, and hand-built JSON in sh breaks on all three. `parseControlBody`
   (`hook-server.ts`) reads both dialects; the desktop's in-process callers still send JSON.
   A `text/plain` `Accept` makes the server render the reply, since sh has no JSON parser.

2. **`RemoteHooks.installCanvasControl`** writes the shim + `SKILL.md` onto the host at connect,
   and merges the same marker-delimited instruction block into the host's `~/.codex/AGENTS.md`,
   `~/.gemini/GEMINI.md` and `${XDG_CONFIG_HOME:-~/.config}/opencode/AGENTS.md` (that last path
   is expanded by the **remote** shell — the desktop's XDG value says nothing about the host).
   `installCanvasSkillIntoAccountDir` covers managed Claude accounts, whose sessions resolve
   skills relative to `CLAUDE_CONFIG_DIR` and never see `~/.claude/skills`.

3. **The env gap** — `remoteHookEnvArgs` injected only endpoint/node-id/version, so a remote
   session inherited neither `NODETERM_AGENT_ID` nor `NODETERM_CANVAS_CONTROL`. The CLI gates
   itself on the latter, so the skill would have been inert on every SSH node even once
   installed. It now mirrors the local `hookServer.buildPtyEnv` exactly, `canControlCanvas`
   gate included.

### Gating and failure behavior

Install is gated on **both** a resolved remote `$HOME` (every remote path must be absolute — a
literal `~` does not expand where these strings land) and a **verified** tunnel: `setup()` only
returns an endpoint path after proving the reverse forward reaches *this* app run. A skill
pointing at a dead socket is worse than no skill, because the agent retries instead of telling
the user canvas control is unavailable.

Everything else fails open, per step: an unwritable instruction file, a host without `curl`, a
dropped connection — the session runs, just without canvas control. Outside a nodeterm-spawned
session the shim exits immediately on its env gate, so it stays inert in the user's own
terminals (same discipline as the managed hook script).

## Testing

`canvas-control-shim.test.ts` runs the **real shim** under `/bin/sh` against a **real** hook
server, over both a TCP port and a **unix socket** — the shim is generated source no compiler
checks, and it is now the only canvas-control client. It covers the nasty-value round trip
(quotes / newlines / `$` / backticks / backslashes), the positional forms, error propagation,
the env gate, a bad token, a dead socket, and reading coordinates from the endpoint file.

## Still owed: context link over SSH (Phase 2)

`get-linked-context` is **not** yet available on SSH nodes. It cannot use the same trick as-is,
because its CLI is a ~230-line parser for three transcript formats (claude JSONL, codex rollout,
gemini event-sourced) — too much to ship as sh, and the host may have no `node`.

The plan is the same shape, one level deeper: put the parsing **on the desktop**.

1. A `/context-link/<verb>` route on the hook server, with the parsing lifted out of
   `CLI_SCRIPT` into ordinary (testable) TS — the string-embedded JS CLI retires with it, and
   the local path collapses onto the same route.
2. Remote reads are already reachable from the desktop: the hook-fed `transcriptPath` for a
   remote node **is a remote path**, readable over the ControlMaster with `SshFs.readText`, and
   `PtyManager.captureSession` is already remote-aware.
3. `resolveLinkTranscript` needs a fix first: for an SSH node it must not fall back to the
   **local** `locateCodex`/`locateGemini`, which would happily resolve some unrelated transcript
   on the wrong machine.
4. **Authorization moves to the route.** Today a node may only read the links in its own link
   file, which the per-node file layout enforces implicitly. Once `nodeId` arrives in a request
   body, the route must check it explicitly — the same class of guard as the board-log relay's
   `sharedProjectId` scope check.

## Out of scope

- **Server Edition** — canvas control is not wired there at all (no `agent:control` handler),
  which this change does not alter. The shim is now portable enough to be reused when it is.
- **Mobile companion** — no canvas, so no canvas control to surface.
- **Relay remote nodes** — a different transport with no client fs; unaffected.
