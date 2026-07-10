# nodeterm Server Edition (Phase 2)

Run nodeterm's canvas in a browser, backed by a headless Node server on your own
machine or box. The server serves the **same** built renderer the desktop app uses
and speaks a WebSocket-RPC protocol to it; a browser-side `window.nodeTerminal`
shim (`src/renderer/bridge/`) stands in for the Electron preload, so the React UI is
unchanged. It boots the same Electron-free core services (`src/core/`) through a
`ServerPlatform`, so terminals get the same tmux session continuity as the desktop app.

> **Phase 2 scope: terminals only.** This is a real, usable terminal canvas over the
> network, but it is deliberately narrow — see [Limitations](#phase-2-limitations).

## Quickstart

```bash
npm run server:dev
```

`server:dev` runs `npm run build` (renderer + core) then `npm run server:build`
(bundles `src/server/main.ts` → `out/server/main.cjs` via esbuild) and finally
`node out/server/main.cjs`. On a repeat run where the renderer is already built you
can skip straight to `npm run server:start`.

### First run (setup token)

With no password configured yet, the server prints a **one-time setup URL** to stdout:

```
Setup: http://127.0.0.1:8443/setup?token=<32-hex>
nodeterm-server listening on http 127.0.0.1:8443
```

Open that URL, choose a password (min 8 chars), and you're signed in. The setup
token is single-use and lives only in memory (never written to disk), so it's
regenerated if the process restarts before setup completes.

### Headless setup (no interactive setup URL)

Seed the password out-of-band with an env var — useful for containers / CI where
nobody is watching stdout:

```bash
NODETERM_SERVER_PASSWORD='choose-a-strong-one' npm run server:start
```

When `NODETERM_SERVER_PASSWORD` is set **and** no password is configured yet, the
server writes the scrypt hash on boot and skips the setup URL entirely — go straight
to `/login`. It is ignored once a password already exists (it never overwrites).

### Manual build + run

```bash
npm run build         # electron-vite build → out/renderer, out/core
npm run server:build  # esbuild → out/server/main.cjs
npm run server:start  # node out/server/main.cjs
```

## Configuration

Precedence: **CLI flag > environment variable > default.**

| Flag | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `--port <n>` | `NODETERM_PORT` | `8443` | TCP port to listen on. |
| `--host <h>` | `NODETERM_HOST` | `127.0.0.1` | Interface to bind. |
| `--data-dir <path>` | `NODETERM_DATA_DIR` | `~/.nodeterm-server` | Where auth, sessions, workspace, settings, and scrollback live. |
| `--renderer-dir <path>` | `NODETERM_RENDERER_DIR` | `out/renderer` (resolved from cwd) | Directory of the built renderer (`index.html` + hashed assets). |
| `--insecure-http` | — | off | Acknowledge serving plain HTTP directly on a non-loopback interface (see below). |
| — | `NODETERM_SERVER_PASSWORD` | — | Seed the password headlessly on first boot (see above). |

Binding a **non-loopback** host (anything other than `127.0.0.1` / `localhost` /
`::1`) **without** `--insecure-http` is refused at startup — plain HTTP on a public
interface would leak the session cookie. The intended deployment is loopback-bound
behind a TLS-terminating reverse proxy (see [TLS](#tls-reverse-proxy)).

## Security model

Single-user auth. There is one password; sessions are per-browser.

- **Password hashing:** scrypt (`N=16384, r=8, p=1`, 32-byte key, per-password random
  salt), stored as `auth.json` (mode `0600`) in the data dir. Login comparison is
  constant-time (`crypto.timingSafeEqual`). The app never stores the plaintext.
- **Session cookie:** on successful login the server sets `nt_session=<random>` with
  `HttpOnly; SameSite=Strict; Path=/` (and `Secure` when served over HTTPS). Sessions
  are persisted (`sessions.json`, mode `0600`) with a 30-day TTL and swept lazily.
  `revokeAll()` exists to drop every session but is only wired programmatically in
  Phase 2 (no logout-everywhere UI yet; `/auth/logout` clears the current cookie).
- **Origin check on WS upgrade:** the WebSocket endpoint requires a valid session
  cookie **and**, when the browser sends an `Origin` header, that its host matches the
  request `Host`. A malformed Origin is rejected (never throws). This blocks
  cross-site WebSocket hijacking. (Non-browser clients without an Origin still must
  present a valid cookie.)
- **Login rate limit / lockout:** 5 failed password attempts trip a 60-second lockout
  (further attempts get `429 too_many_attempts`); a success resets the counter.
- **Auth gate:** every route except the login/setup pages and their POST handlers
  requires a valid session — HTML navigations redirect to `/login`, API/WS get `401`.

### TLS (reverse proxy)

The server speaks **plain HTTP** by design. For anything beyond `localhost`, run it
bound to loopback and put a TLS-terminating reverse proxy (nginx, Caddy, Cloudflare
Tunnel, a VPN, etc.) in front. The `Secure` cookie flag is set automatically when the
proxy forwards HTTPS (detected via `X-Forwarded-Proto` / the request being TLS).
`--insecure-http` only exists as an explicit, eyes-open escape hatch for trusted
private networks — prefer the proxy.

### CSP

The inline login/setup pages carry a strict CSP. The built `index.html` ships with a
`default-src 'self'` marker that the server **rewrites** at serve time to
`default-src 'self'; connect-src 'self' ws: wss:;` so the browser can open the
WebSocket. If that marker is ever missing, the server logs a loud warning (the WS
would otherwise be blocked) — rebuild the renderer or update the rewrite.

## Documented deviations from the spec

Two intentional departures from `docs/superpowers/specs/2026-07-10-server-edition-design.md`:

1. **`node:http` + `ws`, not Fastify.** The HTTP/WS surface is tiny (a handful of
   routes + one WS endpoint); the built-in `http` module plus `ws` keeps the
   dependency footprint minimal and avoids a framework for no gain.
2. **scrypt, not argon2.** scrypt is in Node's standard library (`crypto`), so there's
   no native dependency to build/ship. Parameters follow the OWASP baseline.

## Phase 2 limitations

- **Terminal-only.** Terminal nodes work (spawn, I/O, resize, tmux continuity). The
  git panel, source control, Monaco editor/diff nodes, SDK chat node, agent-status
  badges/hooks, and the folder picker are **not** wired into the server bridge yet —
  their `window.nodeTerminal` methods are stubbed. Deferred to Phase 3.
- **Reconnect = full-page reload.** When the WebSocket drops, the bridge shows an
  overlay and the recovery path is to reload the page; on reload each terminal
  warm-reattaches to its still-running tmux session and tmux redraws. (The spec's
  lighter "thin reconnect strip" is recorded as a v1 tradeoff.)
- **Initial-connect failure shows a blank screen.** If the server is unreachable at
  the very first page load (as opposed to a mid-session drop), the reconnect overlay
  does not appear — you get a blank page. Known follow-up.
- **No backpressure / flow-control auto-trigger.** The `pty.setFlow` plumbing exists
  end-to-end, but nothing automatically pauses a flooding PTY based on WebSocket
  `bufferedAmount` yet. Deferred to Phase 3.
- **Single user.** One password, no accounts/roles.

## Phase 3a: files, editor, diff & source control

Phase 3a widens the browser surface from terminals-only to the file-and-git
workflow. The server now registers the core **fs**, **git**, and **commit-message**
handlers and the browser bridge exposes real `fs` / `git` / `files` / `context`
APIs, so several node kinds and panels that were stubbed in Phase 2 now work in the
browser:

- **Editor & diff nodes** — Monaco editor nodes read/write files over `fs:read` /
  `fs:write` (⌘S saves), and diff nodes render `git:show-file` + `fs:read` — both
  now function unchanged in the browser.
- **Source Control panel** — stage / unstage / discard, diff, branch switch/create,
  commit + push, and the ✦ AI commit message (BYO local agent CLI on the staged
  diff) all run against the server's `git` service.
- **Explorer** — the file tree lists the project `cwd` via `fs:list`.

The following affordances change shape in the browser (no native OS is reachable):

- **Folder / file picker** — there is **no native dialog**. "Open folder…" and file
  pickers use an **in-app server-directory browser** (built on `fs:list`) that lets
  you navigate and pick a path on the server's filesystem.
- **`shell.openExternal`** — opens the URL in a **new browser tab** rather than a
  desktop-side default browser.
- **"Reveal in Finder" / "open with default app"** — **inert** in the browser
  (there is no desktop file manager to reveal into); these actions are hidden or
  no-op rather than erroring.

The **backpressure / flow-control** gap noted in the Phase 2 limitations is now
closed: a flooding PTY is automatically paused based on the WebSocket
`bufferedAmount` and resumed when it drains, so the WS is protected.

> **Loose coordination (follow-up).** The server-side WS backpressure and the
> renderer's terminal (xterm) flow control coordinate only **loosely** over a shared
> pause actuator (`ptyManager.setFlow`) — full two-master coordination is a follow-up.
> Because either side can resume the pty independently, the server **re-asserts** its
> pause on every send while the socket buffer stays above the high-water mark (rather
> than latching on a single rising edge), so a renderer-side resume cannot silently
> latch the server's protection off.

**Still deferred to Phase 3b:** the SDK **chat node** and the **agent-status
badges/hooks** are not yet wired into the server bridge.

## Manual browser smoke checklist

Run against a real browser (this is the human-verified path; the automated harness
only exercises the HTTP/auth surface). With `npm run server:dev` running:

1. **Setup / login** — open `http://127.0.0.1:8443`. On first run you're redirected to
   `/setup` (or use the printed setup URL); choose a password. On later runs you land
   on `/login`; sign in.
2. **Add a terminal** — click the dock `+` and add a terminal node. It should spawn a
   shell and show a prompt.
3. **Terminal I/O** — type `echo hi` and confirm `hi` prints.
4. **Resize** — drag the node's resize handle; the terminal should re-fit (cols/rows
   update) without garbling.
5. **Refresh the page** — reload. The terminal must **warm-reattach** to its tmux
   session and redraw its current contents (running processes survive).
6. **Restart the server** — stop `node out/server/main.cjs`, start it again, reload the
   page. Same warm-reattach: the tmux server outlived the app, so state is intact.
7. **Lockout** — sign out (or open a fresh session), enter the wrong password 5 times;
   the 6th attempt should be rejected with a "too many attempts" lockout for ~60s.
8. **Open a folder (Phase 3a)** — use "Open folder…"; the **in-app server-directory
   picker** appears (no native dialog). Navigate to a git repo on the server and pick
   it; a project opens on its `cwd`.
9. **Edit & save a file (Phase 3a)** — open a file (Explorer or picker) into an editor
   node, make an edit, press ⌘S; the dirty dot clears and the change lands on disk.
10. **Source Control (Phase 3a)** — open the Source Control panel; your edit shows as a
    change. Click it to see the **diff**, **stage** it (+), type a message, and
    **commit**; the file leaves the change list and the commit appears in recent commits.
