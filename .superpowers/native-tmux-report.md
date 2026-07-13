# Revert to native tmux (`fix/native-tmux`)

## 1. Both tmux configs — native, with a working clipboard

`tmuxConf` (`src/core/pty-manager.ts`) and `remoteTmuxConf` (`src/shared/ssh.ts`) are now identical
in behavior:

- `set -g mouse on` — tmux owns the wheel + selection; the pane goes back to the **alternate screen**
  (so a TUI's input box stays put).
- **Deleted** `terminal-overrides ',*:smcup@:rmcup@:indn@'` from both configs, and the remote
  config's `terminal-overrides ',xterm*:Ms=…'` (it emits zero OSC 52 on tmux 3.2+).
- **Clipboard:** kept `set -g set-clipboard on`, **added** `set -as terminal-features ",*:clipboard"`.
  That is what actually makes tmux emit OSC 52 to the client; the renderer's existing OSC 52 handler
  writes the system clipboard. Cross-platform, and it finally works over SSH.
- Restored the copy-mode mouse bindings (`MouseDragEnd1Pane` / `DoubleClick1Pane` select-word /
  `TripleClick1Pane` select-line → `copy-pipe-and-cancel`) with **no `pbcopy`** command.
- Everything else (status off, history-limit, default-terminal, escape-time, destroy-unattached,
  aggressive-resize) unchanged.

The *why* (mouse on = tmux owns scrolling; `terminal-features`, not `Ms=`; no pbcopy) lives in the
TS doc comments above each function, not inside the emitted conf body — the conf text itself is
asserted not to contain `Ms=` / `pbcopy`, so the guards can't be defeated by a comment.

## 2. Warm-reattach hydration — removed end to end

Deleted (with their tests):

| Layer | Removed |
|---|---|
| renderer | `warmSeed` + its call site in `TerminalNode.tsx`; `AttachReplay`'s history state; `SeedPaint`'s `'history'` member |
| transport | `TerminalTransport.captureHistory`, `LocalTransport.captureHistory`, `RemoteTransport.captureHistory` |
| API surface | `PtyApi.captureHistory`, `RemoteClientApi.captureHistory`, `IPC.ptyCaptureHistory`, `IPC.remoteClientCaptureHistory`, the preload entries (both), the ws-bridge entry, the stubs entry |
| core | `PtyManager.captureHistory` + its `registerIpc` registration; `remoteCaptureHistoryArgs` (`control-master.ts`); **`src/core/history-limits.ts` deleted entirely** (`HISTORY_LINES`, `HISTORY_MAX_BYTES`, `clampHistoryLines`) |
| relay | host-side RPC `pty.captureHistory` (`host-service.ts`: handler, dispatch case, `HostPtyApi.captureHistory`); client-side `captureHistory` handler + its IPC (`client-service.ts`) |

**Also became dead and was deleted:** `trimToBytes` (`pty-manager.ts`). Its only two callers were
`PtyManager.captureHistory` and the host `pty.captureHistory` RPC, both of which are gone. The
scrollback-store does **not** use it — it has its own `trailing()` byte cap — so nothing else
needed it.

**Kept (still used):** `captureForResync` / `captureSnapshot` / `captureSession` (the `pty:resync`
drop-and-redraw path and the joiner capture), `readScrollback` / `writeScrollback` /
`scrollback-store` (cold restore), `repaintResync`, `toXtermText`, `stripTrailingNewline`,
`shouldApplyResync`, the xterm `scrollback` option, the copy shortcuts, the OSC 52 handler,
`macOptionClickForcesSelection`, and the browser clipboard fallback in `bridge/stubs.ts`.

### The co-attach joiner still works

`attachReplay` now returns `'cold-snapshot' | 'warm-attach' | 'none'`. A warm reattach
(`warm-attach`) seeds **nothing** — tmux redraws the pane and owns its history.

**Deviation from the letter of the brief, deliberate:** the brief said the warm state simply goes
away, but `seedPaint`'s `create-screen` branch is *only reachable* from the warm state (a joiner is
`fresh:false`, and `replay: 'none'` short-circuits to "paint nothing" — which is also what a parked
terminal returns, and a parked terminal must never be repainted). Collapsing warm into `'none'`
would therefore have silently broken the joiner, or forced `'none'` to stop meaning "paint nothing".
So the state was **renamed** `warm-history` → `warm-attach` and emptied of its history behavior: it
now yields `create-screen` when a joiner's `PtyCreateResult.screen` is present and `none` otherwise.
The joiner's paint is unchanged in behavior (`'\x1b[0m' + toXtermText(stripTrailingNewline(screen))`
— the same bytes `warmSeed` wrote for a screen-only seed, minus the removed history padding).

## 3. Docs

- `CLAUDE.md` → "Terminal session continuity (tmux)" rewritten: tmux owns the mouse, the wheel
  scrolls tmux's own history, the pane is on the alternate screen, selection is copy-mode and the
  clipboard is reached via `set-clipboard on` + `terminal-features clipboard` → OSC 52 → the
  client's handler (no pbcopy, works over SSH). Explicitly records that the `Ms=` terminal-overrides
  entry does **not** work on tmux 3.2+, and why the previous emulator-scrollback design failed
  (tmux is a screen painter, not a stream). The "Seeding a fresh xterm" section now documents two
  seeds + the joiner exception; the hydration prose is gone.
- `CLAUDE.md` → the **terminal** node-kind bullet no longer claims selection is the emulator's.
- `docs/team-presence.md` → the paragraph that made `screen` a *fallback* behind `captureHistory`
  now says `screen` is the joiner's sole paint (the hydration it deferred to no longer exists).

## Verify

- `npx vitest run` → **1251 passed, 1 failed, 2 skipped**. The single failure is
  `src/core/workspace-watcher.test.ts > fires for an outside edit, but not for a self-write`, which
  is **pre-existing** — verified by `git stash`-ing this branch's changes and re-running it on the
  clean tree, where it fails identically. Nothing else fails.
- `npm run typecheck` → clean.
