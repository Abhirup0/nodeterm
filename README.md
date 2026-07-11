<div align="center">

<img src="docs/assets/nodeterm.png" alt="nodeterm" width="120" height="120" />

# nodeterm

**A node-based terminal manager — your terminals on an infinite canvas.**

Multiple real terminals live as draggable nodes on a single pan/zoom canvas.
Built for people with ADHD and scattered workflows: a spatial layout instead of
a stack of hidden tabs.

[![Platform](https://img.shields.io/badge/platform-macOS%20(arm64%20%2B%20x64)-black)](https://nodeterm.dev)
[![Built with Electron](https://img.shields.io/badge/built%20with-Electron-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/license-BUSL--1.1-blue)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/eneskirca/nodeterm?style=flat)](https://github.com/eneskirca/nodeterm/stargazers)
[![Latest release](https://img.shields.io/github/v/release/eneskirca/nodeterm?include_prereleases&sort=semver)](https://github.com/eneskirca/nodeterm/releases)

[Download](#-download) · [Features](#-features) · [Build from source](#-build-from-source) · [Architecture](#-architecture) · [License](#-license)

</div>

---

<div align="center">
  <img src="docs/assets/hero.png" alt="nodeterm canvas — terminals, a Claude Code node, a sticky note, and an editor on one pan/zoom canvas" width="900" />
  <br/>
  <sub><i>Illustration of the canvas — swap in a real screenshot/GIF when ready.</i></sub>
</div>

## Why nodeterm

Stacked terminal tabs hide context — you lose track of what's running where. nodeterm
turns that into a **map**: every shell is a node you can place, group, label, and zoom
into. Sessions are spatial and persistent, so your mental model stays intact across
restarts. And because the app is built around a clean service seam, the same canvas now
runs three ways — as the **macOS desktop app**, as a **self-hosted browser app** you
reach from anywhere (Server Edition), and (in progress) a **mobile companion**.

## ✨ Features

- **Real terminals as nodes** — each node runs its own shell (PTY) via `node-pty`; drag,
  resize, pan, and zoom freely on a React Flow canvas.
- **Session continuity (tmux)** — terminals keep running across node remounts *and* full
  app restarts, including live processes. Close a node's × to truly end its session.
- **Projects / tabs** — each project is its own canvas with its own working directory;
  switch between them without losing any running terminal.
- **Many node kinds**, all on the same canvas:
  - 🖥 **Terminal** — xterm + tmux, click-to-rename, color, tags, AI naming.
  - 🤖 **Agent** — a terminal preset that launches an agent CLI: **Claude Code**, **Codex**,
    **Gemini**, or your own custom command.
  - 💬 **Chat** — an SDK-driven Claude chat node (streaming, in-chat permission prompts,
    image paste, cost meter) — not a PTY.
  - 📝 **Sticky note** — free-text colored notes; link one to an agent to feed it context.
  - 🗂 **Group** — frame and move related nodes together.
  - ✏️ **Editor** — Monaco code editor for a file (⌘S to save, markdown/image preview).
  - 🔀 **Diff** — Monaco diff editor for staged/unstaged changes.
  - 🌐 **Web / Video** — render a page or a video right on the canvas.
- **Live agent status** — hook-driven **RUNNING / NEEDS YOU** badges, **subagent** cards
  with a live transcript, a **context-window meter**, and unread dots + completion
  notifications — for Claude, Codex, and Gemini, no output-scraping.
- **Agent superpowers** — **context links** so two agent nodes (Claude / Codex / Gemini) can
  read each other's transcript on demand, plus Claude-only **branch a conversation** into a
  new node and **managed accounts** to run several logged-in Claude identities side by side.
- **Remote / SSH projects** — open a project on a remote host over SSH; terminals, files,
  and git run there while the canvas stays local.
- **Source control** — VS Code-style file-level stage/unstage, discard, branch
  switch/create, commit, push/sync/publish, worktrees, and `gh` sign-in — backed by
  system `git`.
- **AI commit messages & terminal names** — bring-your-own local agent CLI
  (claude / codex / custom) run read-only on the staged diff or captured output.
- **Command palette** (⌘K), **file explorer** (⌘⇧E), **markdown view** (⌘M),
  **undo/redo** (⌘Z / ⌘⇧Z), and a native macOS dark UI.
- **Auto-update & in-app announcements** — the app checks a self-hosted feed and
  surfaces a "Restart to update" banner and product news.

### 🌍 Server Edition — nodeterm in your browser

The same canvas runs headless on a Linux (or macOS) host and is used from any browser —
so your terminals, editors, source control, and agents live on a server you reach from
anywhere. Single-user auth (password + secure cookie), a WebSocket bridge, and the exact
same renderer as the desktop app.

```bash
npm run server:dev     # build + serve; open http://127.0.0.1:8443 and set a password
```

Terminals, files/editor/diff, the full git panel, and agent-status badges all work in the
browser today; the SDK chat node is the one piece still desktop-only. See
[`docs/SERVER.md`](./docs/SERVER.md) for the quickstart, security model, and current
limitations.

## 📦 Download

Grab the latest `.dmg` from **[nodeterm.dev](https://nodeterm.dev)** (Apple Silicon and
Intel builds). The app auto-updates itself from there.

> Until the build is signed & notarized, macOS Gatekeeper may warn on first launch —
> right-click the app → **Open** to bypass it once.

## 🛠 Build from source

Requires Node.js 20+ and macOS.

```bash
npm install        # deps + rebuilds node-pty against Electron's ABI (postinstall)
npm run dev        # dev mode with renderer HMR
npm run build      # production build into out/
npm start          # preview the production build
npm run typecheck  # fastest correctness gate
npm test           # vitest unit + integration suite
npm run dist       # local UNSIGNED .dmg into dist/ (smoke test)
npm run server:dev # build + run the browser Server Edition (needs Node 22 + tmux)
```

`npm run dist` builds an unsigned `.dmg` for local testing; `npm run server:dev` runs the
headless browser edition.

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘K` | Command palette |
| `⌘T` / `⌘⇧C` | New terminal / New Claude Code |
| `⌘W` | Close the selected node |
| `⌘Z` / `⌘⇧Z` | Undo / Redo |
| `⌘M` | Toggle markdown view (terminal / editor) |
| `⌘⇧E` | File explorer |
| `⌘,` | Settings · `⌘/` Shortcuts |
| `Right-click` | Actions menu (empty space or node) |

## 🏗 Architecture

- **Electron, three contexts** — `src/main` (the Electron shell), `src/preload` (the only
  bridge, `window.nodeTerminal`), `src/renderer` (React UI). `src/shared` holds the types
  and IPC channel names used by all three.
- **`CorePlatform` seam** — every service (PTY, workspace/settings, git, agents, hooks) lives
  in `src/core` behind a small platform interface and never imports `electron`. Electron is
  one implementation of that seam; the browser Server Edition (`src/server`) is another,
  booting the exact same services over a WebSocket-RPC bridge (`src/renderer/bridge` fills
  `window.nodeTerminal` in the browser). One codebase, one renderer, multiple shells.
- **`TerminalTransport` abstraction** — the renderer depends only on this interface, never on
  IPC or node-pty directly. `LocalTransport` talks to the local host; `RemoteTransport` talks
  to a remote agent over SSH — so remote projects drop in without touching the canvas UI.
- **React Flow is the single source of truth** for live nodes; projects persist serialized
  nodes to disk, and tmux keeps sessions alive across restarts.
- **Three surfaces** — the desktop app, the browser **Server Edition**, and an in-progress
  **mobile companion** (a separate SwiftUI repo) all ride the same core + transport seams.

See [`CLAUDE.md`](./CLAUDE.md) for the full design notes and gotchas, and
[`docs/SERVER.md`](./docs/SERVER.md) for the Server Edition.

## 🤝 Contributing

Issues and pull requests are welcome. nodeterm is licensed under the
[Business Source License 1.1](https://mariadb.com/bsl11/) — you can use, modify,
and redistribute it freely, including in production, except offering it as a
competing product or service (see [License](#-license)).

By submitting a contribution (pull request, patch, or code snippet), you agree
that it is licensed under the same [BUSL-1.1](./LICENSE) terms as the rest of
the project, and that the project may continue to relicense future versions
(including your contribution) as part of its normal licensing model.

## 📜 License

**[BUSL-1.1](./LICENSE)** ([Business Source License](https://mariadb.com/bsl11/)): you may
copy, modify, redistribute, and — under the Additional Use Grant — make **production
use** of nodeterm; the one thing you may not do is offer it (hosted, embedded, or as a
standalone product/service) in a way that **competes** with nodeterm or with the
Licensor's products built on it. Each release automatically becomes plain **MIT** four
years after it is published. See [`LICENSE`](./LICENSE) for the full terms and
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) for the bundled open-source
components. For a commercial license beyond the grant, contact eneskirca@gmail.com.

> "Claude" and "Claude Code" are trademarks of Anthropic; nodeterm is not affiliated with
> or endorsed by Anthropic.
