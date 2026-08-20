# Probe — `webContents.debugger.attach()` vs an open DevTools window

**Design claim under test:** S8 browser-control design, `[UNVERIFIED] 2` — the worry that a
programmatic debugger attachment and a user-opened DevTools window are *mutually exclusive* on the
same `<webview>` guest, i.e.

1. `webContents.debugger.attach()` **fails** while the user has DevTools open on that guest, and/or
2. an active attachment **blocks** the user from opening DevTools.

If (1) held, Task 5.3's attach-failure path had to surface *that* cause verbatim
(*"browser-3 has DevTools open; close them to let an agent drive it"*), never "not drivable"
(design §2.3 rule 1). If (2) held, that usability cost had to be recorded in PR 6's indicator
tooltip.

## Environment

- **Electron 42.8.1** (`package.json:142`, `node_modules/electron/dist/version` = `42.8.1`).
- Linux, headless, `xvfb-run` + `--no-sandbox --disable-gpu`.
- Real `BrowserWindow` (`webviewTag: true`) hosting a real `<webview>` guest; guest `webContents`
  obtained from the `did-attach-webview` event — the same object the app drives.
- Probe source: `scratchpad/probe/main.js` (`attach('1.3')`, `openDevTools({ mode: 'detach' })`,
  `isDevToolsOpened()`, `debugger.isAttached()`, `debugger` `detach` event). Reproduced twice,
  identical results.

## Measured result

| Test | Action | Outcome |
|------|--------|---------|
| **A** | DevTools opened first (`isDevToolsOpened() === true`), then `debugger.attach('1.3')` | **attach SUCCEEDED** — no "Another debugger is already attached" throw |
| **B** | `debugger.attach('1.3')` first (`isAttached() === true`), then `openDevTools()` | **DevTools opened** (`isDevToolsOpened() === true`) **and the programmatic attachment stayed live** (`isAttached() === true`); no `detach` event during the DevTools window (the only `detach` seen, reason `target closed`, fired at webContents teardown) |

## Conclusion

**On Electron 42.8.1 the two are NOT mutually exclusive — they coexist.** A programmatic CDP client
and the user's DevTools frontend attach to the same guest at the same time (modern Chromium
multiplexes multiple protocol clients per target). Neither branch of `[UNVERIFIED] 2` reproduces:

- attach does **not** fail because DevTools is open, so Task 5.3's DevTools-specific sentence is
  **unreachable on this version** — it is documented and kept out of the hot path rather than
  emitted. The generic attach-failure path remains (attach can still throw for a destroyed /
  crashed / detached target), and it names a **named** outcome, never "not drivable".
- attaching does **not** block the user's DevTools, so there is **no usability cost** to record in
  PR 6's tooltip.

This **refines** the design (one conditional branch measured unnecessary); it does **not**
contradict the lease mechanism, so PR 5 proceeds. If a future Electron bump reintroduces the
single-client rule, re-run this probe: the attach-failure handler in `browser-lease.ts` already
degrades to a named refusal, and only the DevTools-specific wording would need re-enabling.
