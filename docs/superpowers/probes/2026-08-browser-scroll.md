# Probe — `--scroll` wheel translation ( [UNVERIFIED] 1 )

**Design claim under test:** S8 browser-control design, `[UNVERIFIED] 1` — S8's comment that
*"Electron acknowledges Chromium's synthetic mouse gesture without scrolling a webview"*, i.e.
`Input.synthesizeScrollGesture` does not scroll an Electron `<webview>` guest, and the salvage is to
translate the intent into an `Input.dispatchMouseEvent { type:'mouseWheel', x, y, deltaX, deltaY }`.

The design's own warning: gesture *distance* is the OPPOSITE sense to wheel *delta*, so a naive
translation flips the sign — the page scrolls the wrong way and it looks like a coordinate bug.

## What PR 8 implements

`browser-actions.ts:scrollDeltaY` / `browserScroll`:

- `Input.synthesizeScrollGesture` stays **excluded** from the CDP allowlist (it is in the refused
  list in `browser-cdp-allowlist.test.ts`), so the ONLY scroll door is a `mouseWheel` event through
  the existing, viewport-bounded `Input.dispatchMouseEvent` entry — no new CDP method is added for
  scroll.
- The wheel delta is authored **directly in the DOM wheel convention** — positive `deltaY` scrolls the
  page DOWN (`scrollY` grows) — rather than by translating a gesture *distance*. So the sign-inversion
  S8 warned about (gesture-distance → wheel-delta) is **not present**: there is no gesture distance
  being converted. `down` → `+0.9·viewport`, `up` → `−0.9·viewport`, `top`/`bottom` → to the edge from
  the current offset, a signed pixel count taken literally.
- **The reply is built from the re-measured movement, never the requested delta.** After the wheel
  event, `browserScroll` re-reads `Page.getLayoutMetrics` and reports the ACTUAL `scrollY` delta and
  position: `scrolled browser-3 down 600px (at 1200/4400)`. A command that succeeds and does nothing
  (wrong sign, non-scrollable page, already at the edge) surfaces as `0px` or an opposite-direction
  delta the agent can see — the "succeeds and does nothing" failure shape cannot hide.

## Measured result

**NOT re-measured against a real Electron 42.8.1 `<webview>` in the implementation environment.**
The implementer's environment is headless with no display; the same reason the reader/pointer
end-to-end `<webview>` harness (Global Constraint 8) is deferred in this repo's vitest suite (see the
note in `src/main/browser-actions.test.ts`). Running this probe needs `xvfb-run` + a real
`BrowserWindow(webviewTag:true)` hosting a `<webview>` — the same rig used for the
`2026-08-browser-debugger.md` probe — which is not available here.

Per Global Constraint 8 ("a probe that cannot be run on the implementer's machine is not silently
skipped: the task stops and reports"), this is **reported, not skipped**: the implementation is
written to the design's translation and, critically, the read-back reply makes any residual sign/no-op
error observable to the agent rather than silent.

## To verify (owed, device/display run)

On a machine with a display (or `xvfb-run`), Electron 42.8.1:

1. Load a tall page (content height ≫ viewport) into a canvas `<webview>` browser node.
2. `browser --node <id> --scroll down` → expect the reply's delta POSITIVE (`down N px`) and `scrollY`
   to have increased by ~N; confirm the page visibly moved down.
3. `--scroll up`, `--scroll top`, `--scroll bottom`, `--scroll 600`, `--scroll -600` → each reply's
   direction/delta matches the observed movement.
4. If any direction is inverted, flip the sign in `scrollDeltaY` only — the read-back reply already
   named the error, so the fix is one line and the test that pins the reply shape stays green.
