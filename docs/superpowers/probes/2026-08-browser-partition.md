# Probe — webview `partition` identity and discard/restore

**Date:** 2026-08 · **Electron:** 42.8.1 (`package.json` `"electron": "^42.8.1"`) · **Platform:** Linux
(headless, `xvfb`, `--no-sandbox`, `--disable-gpu`) · **S8 PR 4 Task 4.0**

Two structural claims of the browser-control design were marked `[UNVERIFIED]` and neither had been
run. This probe drives a **real Electron `<webview>`** (never a JSDOM/hand-rolled fixture, per global
constraint 8): a real `BrowserWindow` with `webviewTag: true`, a real local HTTP origin
(`http://127.0.0.1:<port>`, because `data:` URLs cannot hold cookies), real `session` cookie APIs,
and real guest `document.cookie` reads. Harness: `scratchpad/s8probe/main.cjs`.

## Results — the design HELD on all three

### Probe A ([UNVERIFIED] 4) — is a `partition`-less `<webview>` really on `session.defaultSession`?

**YES — genuinely shared with the app window, both directions.**

- A cookie set in `session.defaultSession` (`appwin=1`) is visible as `document.cookie` in a
  `partition`-less guest for the same origin.
- A cookie set from *inside* the `partition`-less guest (`fromguest=1`) is then present in
  `session.defaultSession.cookies.get()`.

So §9's "…and the app's own window" clause is **correct and stays** — a partition-less (user-opened)
browser node shares the exact jar the app window uses. This is precisely why agent-opened nodes must
get their **own** named partition: a partition-less agent node would otherwise read whatever the user
is already logged into.

### Probe B ([UNVERIFIED] 3) — does a discarded+restored named-partition webview rejoin the same jar?

**YES.** Logged in (`jar=B`) in a `persist:nt-agent-browser-probe` webview; unmounted the element
(exactly what the memory saver does — `BrowserSurface` removes the `<webview>` to end the guest);
remounted a fresh `<webview>` with the **same** named partition → `jar=B` is still sent.

Consequence: the memory saver does **not** silently log the agent out on discard. **No stop-and-report.**
Task 5.4's discard suppressor is therefore load-bearing for *state* (avoiding a reload flash / lease
churn), **not** for correctness. A `persist:` partition is a durable, named session keyed by its name.

### Probe C — is a `partition` *mutation* after attach ignored?

**YES — ignored, silently (no throw).** A guest attached on `persist:nt-agent-browser-probe`
(holding `jar=B`); after attach the element's `partition` attribute was mutated to
`persist:nt-agent-browser-other` (an empty jar) and the guest reloaded → it **still** reports
`jar=B`, i.e. it stayed on the original partition. Electron honours `partition` **only at attach**.

This is the measured justification for Task 4.1 setting the node's `partition` **once at creation and
never mutating it**: a post-attach mutation would be a no-op anyway, so the immutable field matches
the platform's real behaviour instead of implying a control it does not have.

## Raw measurement

```
PROBE_RESULT electronVersion "42.8.1"
PROBE_RESULT probeA {"partitionlessGuestCookie":"appwin=1","appwinVisibleInPartitionless":true,"guestCookieInDefault":true}
PROBE_RESULT probeB {"beforeDiscard":"jar=B","afterRestore":"jar=B","rejoinsSameJar":true}
PROBE_RESULT probeC {"cookieAfterMutation":"jar=B","mutationThrew":false,"stillOnOriginalJar":true}
```
