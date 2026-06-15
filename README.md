# node-terminal

Open-source **node-based terminal manager**. Place multiple real terminals freely on a
single canvas, drag them around, pan and zoom in/out. Built for people with ADHD and
disorganized workflows — it turns a scattered workflow into a visual, spatial layout.

> MVP scaffold. Today: multiple running terminals · drag-and-drop · pan/zoom · save/load
> layout · grouping by title + color.

## Features (MVP)

- **Multiple terminals** — each node runs its own real shell (PTY).
- **Canvas** — drag-and-drop, pan, and zoom in/out on top of React Flow.
- **Persistent layout** — node positions, sizes, title/color, and viewport are saved to disk.
- **Visual organization** — group terminals with a title and color tag.

## Development

```bash
npm install      # dependencies + rebuilds node-pty for Electron (postinstall)
npm run dev      # run in dev mode with HMR
npm run build    # production build (out/)
npm start        # preview the production build
npm run typecheck
npm run rebuild  # rebuild node-pty against the Electron ABI (if needed)
```

## Architecture

- **Electron + node-pty** — the main process manages the real PTY processes.
- **React + React Flow + xterm.js** — the renderer; each node embeds an xterm terminal.
- **Transport abstraction** — the renderer depends only on the `TerminalTransport`
  interface. The MVP ships `LocalTransport` (IPC → node-pty). A future `RemoteTransport`
  (remote access) implements the same interface, so it can be added without changing the UI.

See `CLAUDE.md` for details.

## License

MIT
