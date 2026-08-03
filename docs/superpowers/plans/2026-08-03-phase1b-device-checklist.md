# GlyphGrid Phase 1b — device acceptance checklist

**This document is the acceptance gate for the experimental shared terminal renderer.** Phase 1b
is code-complete and unit-tested, but the parts that matter most — WebGL2, xterm's internals,
layout, fonts, IME, the macOS compositor — have no coverage in the (node-environment) test suite
by design. Nothing here can be verified in CI; everything here has to be seen on a real machine.

Run it on the Mac, on a project with **at least a dozen terminals** (agent CLIs streaming output,
not idle shells). Tick each box only when the stated observation is what actually happened; note
anything else inline. Items marked **[1a]** re-run the Phase 1a acceptance so a regression in the
engine is caught before the integration is judged.

Branch: `feat/glyphgrid-engine`. Setting: **Settings → Terminal → Terminal rendering**
(`Auto (default)` / `GPU per terminal` / `Shared GPU (experimental)` / `Off (DOM renderer)`).

**Before you start — the setting is one-way against older builds.** `"shared"` is a value only this
branch knows: running an OLDER build against the same data dir (the released desktop app, or a
Server Edition still on `main` pointed at that `settings.json`) validates the unknown value away and
**permanently rewrites `"terminalGpuRendering": "shared"` back to `"auto"`** on its next settings
save. This is safe — it degrades to the default renderer, nothing is lost but the choice itself —
but it is silent and not undone by relaunching this branch, so if a checklist item suddenly reads
Auto after you switched builds, that is why: re-select Shared and carry on.

---

## 1. Setup and baseline

- [ ] **1.1 Default is untouched.** Fresh launch on this branch with an existing `settings.json`:
      the row reads **Auto (default)**, terminals look and behave exactly as they do on `main`.
      (Auto is the only mode most users will ever be on; a difference here is a release blocker.)
- [ ] **1.2 The row is a select, not a switch.** Four options in this order: Auto (default) /
      GPU per terminal / Shared GPU (experimental) / Off (DOM renderer). The description mentions
      that Shared GPU is experimental, "may render incorrectly", and "falls back to DOM on
      failure". Settings search for "gpu", "webgl", "shared" and "experimental" all find the row.
- [ ] **1.3 Baseline screenshots on Auto.** One busy terminal (agent CLI mid-run, colors, a box-
      drawing TUI) and one `ls --color` / `htop` screen, at 100% canvas zoom. These are the
      side-by-side reference for §2.
- [ ] **1.4 Context baseline.** DevTools → Rendering/Performance (or `about:gpu`): with
      **GPU per terminal** on a canvas of ~12 visible terminals, several WebGL contexts exist
      (budget-capped: 10 on macOS).
- [ ] **1.5 Flip to Shared.** No reload, no restart: the setting alone. **Exactly ONE** WebGL2
      context exists for the whole page afterwards, and the per-terminal ones are gone.
- [ ] **1.6 [1a] Harness green.** The Phase 1a harness still reports **43/43** on this machine.
- [ ] **1.7 [1a] Throughput.** The harness's rows-up/s figure is at or above the Phase 1a number
      recorded for this Mac.
- [ ] **1.8 [1a] Overlap trio.** The harness's three overlap cases (above / below / equal z) still
      paint in the stated order.

## 2. Visual parity (shared vs DOM)

- [ ] **2.1 Text, not a rectangle.** Every visible terminal shows its TEXT immediately after the
      flip — not a dark/blank body. (The node body is transparent in shared mode; what you see is
      the grid's own opaque plate plus glyphs.)
- [ ] **2.2 Side-by-side parity.** Same screens as 1.3, now in Shared: glyph shapes, spacing,
      baseline and line height match the DOM screenshots. No clipped descenders, no overlap
      between adjacent cells, no visible atlas seams.
- [ ] **2.3 Colors.** `ls --color` and `htop`: foreground/background colors, bold and dim, and the
      256-color/truecolor ramps match the DOM rendering. Reverse-video cells (selected row in
      `htop`, `vim` visual mode) are inverted, not blank.
- [ ] **2.4 Plate is the body background.** The terminal body's background is the theme background,
      not the canvas dot grid — **edge to edge**: under the last row, past the last column, and
      around the host padding on all four sides. The plate is the BODY rect now, so there is no
      band left to except (see 2.13).
- [ ] **2.5 Wide chars.** CJK (`日本語`) and emoji occupy two columns each, with the following text
      still on the same column grid as the DOM rendering. A wide glyph is not clipped in half.
- [ ] **2.6 Combining sequences.** A decomposed grapheme (e.g. `e` + U+0301) renders the BASE
      character — the accent may be missing, but never a lone accent mark on a blank cell.
- [ ] **2.7 Atlas fidelity at dpr 1 and 2.** On the retina display and on an external 1x display,
      with a non-default font family and size (e.g. Menlo 11, JetBrains Mono 16): text is crisp,
      not soft or doubled. The float tie this item used to warn about is **closed**: the atlas is
      rasterized at xterm's exact device cell (1:1 texels) *and* the filter no longer depends on
      which side of the λ=0 mag/min boundary a driver resolves to — `MIN_FILTER` is set from the
      camera (**NEAREST at zoom ≥ 1**, where the snapped pan makes it bit-exact; **LINEAR below 1**,
      so a zoomed-out thumbnail stays readable), and MAG stays NEAREST. **Report any softness that
      remains AFTER this**: with the sampler made deterministic, what is left points at the atlas
      RASTER itself (the canvas rasterizer's antialiasing / baseline rounding, or L14's
      first-terminal cell latch), not at the sampler. Also zoom OUT past 1 and confirm the text
      degrades smoothly rather than speckling.
- [ ] **2.8 Selection visual.** Drag-select inside a terminal: the selection band covers exactly
      the selected cells, with correct fg/bg inversion, and matches what the DOM renderer draws.
- [ ] **2.9 Cursor.** A focused terminal shows a solid block cursor at the right cell. It is
      **static** — it does not blink even with "Cursor blink" on (known limitation L1).
- [ ] **2.10 Cursor at end of line.** Type until the cursor sits past the last column (deferred
      wrap): the cursor is drawn on the LAST column, not off-screen or on the next row.
- [ ] **2.11 Cursor hidden by a TUI.** Open a fullscreen CLI that hides the cursor (any agent CLI,
      `less`, `htop`): no stray block cursor is painted anywhere on the grid.
- [ ] **2.12 Blur.** Click away from a terminal: the cursor DISAPPEARS (the DOM renderer draws a
      hollow outline — known limitation L2), and the selection stays visible in the same color as
      when focused (known limitation L3). Judge whether either is acceptable to ship.
- [ ] **2.13 Plate geometry.** Look at the four corners and the right/bottom edges of a terminal
      body. Expected: **no bands anywhere** — the plate is the body rect, so the fit slack at the
      right/bottom and the padding seams on the left/top are all inside it (the round-2 fix; the
      previous grid-sized plate is what put them there). The one artifact that REMAINS is L4: the
      plate is a SQUARE rect under a node with `border-radius: 10px`, so the body's four corners
      read square. Judge how visible that is at normal zoom, and report any band you still see —
      a band now means the plate rect is not tracking the body, not that it is undersized by
      design.
- [ ] **2.14 Scroll area after a font change.** Change the font size while shared is on, then look
      at the scrollbar/scroll area geometry: the thumb matches the content, no phantom region.
- [ ] **2.15 Cursor on a wide glyph.** Put the cursor ON a double-width character (type `日本語`
      and walk the cursor back over it, or `vim` with the cursor on an emoji): KNOWN — the block
      covers only the LEFT half-cell of the glyph instead of both columns (L13). Confirm that is
      what you see, and judge how visible it is at normal zoom.

## 3. Interactions

- [ ] **3.1 Wheel scrolls tmux history.** Wheel over a terminal scrolls tmux's own scrollback, the
      text repaints correctly at every step, and there are no blank or duplicated rows.
- [ ] **3.2 Selection alignment, tall terminal.** In a tall terminal (fractional character height),
      select near the BOTTOM: the highlighted cells are the ones under the pointer — no vertical
      drift accumulating down the node.
- [ ] **3.3 Rectangular selection.** Alt/Option-drag a column block: the selected rectangle matches
      the drag, and the copied text is the column block.
- [ ] **3.4 Copy.** A selection made in shared mode copies the right text (OSC 52 path unchanged).
- [ ] **3.5 IME.** Turkish dead keys and (if available) a CJK IME: the composition popup appears
      over the right cell, composed text lands correctly, and the composition view is not hidden by
      the shared-mode CSS.
- [ ] **3.6 Accessibility.** With screen-reader mode / the a11y tree open, the terminal's text is
      still exposed (the `.xterm-rows` are `visibility: hidden` in shared mode — confirm the a11y
      layer is not).
- [ ] **3.7 Pan/zoom under load.** With ~12 terminals streaming, pan and zoom the canvas: text
      tracks the nodes with no lag, tearing or drift, and the frame rate stays comfortable.
- [ ] **3.8 Overlap occlusion.** Drag two terminals until they overlap: the one on top hides the
      one below — its text does not bleed through, and the lower one's text does not paint over
      the upper node's chrome.
- [ ] **3.9 Selecting the LOWER of two overlapping terminals.** Click the partially-covered one:
      React Flow elevates it, and its TEXT comes up with it — it must not stay occluded by the
      other node's plate.
- [ ] **3.10 Group-parented terminal.** A terminal inside a group frame: its text sits exactly in
      its body (offset chain resolves through the parent), and its paint order relative to
      ungrouped terminals is sane (known limitation L7).
- [ ] **3.11 Letterboxed / oddly-sized node.** Resize a node so the fit leaves slack, and open a
      co-attached node that a smaller peer is letterboxing: the text stays inside the body, aligned
      with the mouse, **and the letterbox bands are terminal background, not canvas**. Reasoning to
      verify by eye rather than assume: `.term-node__xterm.letterboxed` centers a SMALLER `.xterm`
      inside the body, so the leftover space sits on all four sides — the plate is the body rect,
      which contains the centred screen whichever way the slack falls, so it covers every band.
      This was L5's worst case (tens of pixels of dot grid); it is the sharpest test that the plate
      really is body-sized.
- [ ] **3.12 Programmatic camera.** ⌘K jump to a node, a notification click, and a fitView: the
      text lands with the node — no frame where glyphs sit at the old position or at the origin.
- [ ] **3.13 Stacking.** The canvas is ABOVE the dot grid and BELOW node chrome; the bottom-left
      Controls, the minimap and the drawers are all still clickable over a terminal's body.
- [ ] **3.14 ⌘F in a busy terminal.** Open the find bar and search for a word well up in the
      scrollback: matches are found and scrolled to, and the counter (`n of m`) is right;
      KNOWN — the match HIGHLIGHTS are not visible (L12). Navigating next/previous still moves the
      viewport to each hit, so judge whether searching is usable without the highlight.

## 4. Lifecycle

- [ ] **4.1 Enable with terminals already mounted.** (The T6 decision.) With Shared off and a
      canvas full of live terminals, switch to Shared: **every visible terminal joins immediately**
      — no project switch, no refresh, no blank bodies.
- [ ] **4.2 Disable with terminals mounted.** Switch back to Auto/GPU per terminal: every terminal
      returns to normal TEXT immediately (never blank), the shared context is released (DevTools:
      zero glyph contexts), and per-terminal contexts are granted again for the visible ones.
- [ ] **4.3 Off → Shared → Off → Shared** twice in a row: no accumulation of contexts, no warning
      spam, terminals readable in every state.
- [ ] **4.4 Font size change, no remount.** With shared on, change the font size: the text rescales,
      the grid stays aligned with the mouse (click at a known cell and check the cursor lands
      there), and the selection still matches the drag.
- [ ] **4.5 Font family change.** Same, with a different family; glyphs are re-rasterized (no
      leftovers from the previous font).
- [ ] **4.6 Ten font changes in a row.** Repeat 4.4/4.5 ~10 times: the shared renderer never
      permanently fails, and DevTools still shows exactly one WebGL context.
- [ ] **4.7 dims.css.cell on a fresh mount.** Open a NEW terminal node while shared is on: it joins
      the shared canvas at the right cell size (no warn in the console about "cell size
      unavailable", no half-size text).
- [ ] **4.8 Park and adopt.** Switch to another project and back within 5 minutes: the adopted
      terminal shows its text at the correct size and position, and the swap-heal did not leave a
      stray black canvas over it.
- [ ] **4.9 Park beyond 5 minutes.** Same, after the park window expires (cold re-attach): the
      terminal re-registers and paints.
- [ ] **4.10 Adopt after a font change.** Change the font while a project is parked, then switch
      back: check the adopted terminal's cell size against the mouse (known limitation L6 — a
      stale cell would show as text/mouse drift healed only by refreshing the node).
- [ ] **4.11 Collapse / expand.** Collapse a terminal: its glyphs disappear with the body (nothing
      is left painted on the canvas). Expand: the text comes back.
- [ ] **4.12 ⌘M markdown view.** Toggle it on: the glyphs are gone behind the panel. Off: back.
- [ ] **4.13 Respawn (Refresh terminal).** The node's ↻ action: fresh attach, text paints, no
      duplicate grid, no transparent-but-empty body.
- [ ] **4.14 Alt-screen transitions.** Enter and leave a fullscreen TUI (`htop`, an agent CLI) a
      few times: no flicker of a doubled screen, no leftover rows from the previous screen.
- [ ] **4.15 dpr change.** Drag the window between the retina display and an external 1x monitor
      (both directions): geometry stays correct (the drawing buffer follows), text may soften
      slightly (atlas is not rebuilt — Phase 2), and nothing re-registers or fails.
- [ ] **4.16 Kanban board.** Open the board over a shared-mode project: the board is fully opaque
      (no glyphs showing through), and the idle rAF cost is not noticeable (check CPU/GPU while
      the board is up with terminals idle).
- [ ] **4.17 Card modal.** Open a session's card modal while the canvas terminal is on the shared
      canvas: the modal's own terminal renders through xterm's DOM renderer (known limitation L8)
      and both views stay live and correctly sized.

## 5. Failure paths

- [ ] **5.1 Forced context loss.** Force `WEBGL_lose_context` on the shared canvas: exactly ONE
      warning in the console, the rAF loop stops, EVERY terminal returns to readable DOM text, and
      nothing is blank. The mode stays failed for the rest of the session (by design — no retry
      loop), and the Settings row still reads Shared.
- [ ] **5.2 Recover from a failure.** After 5.1, switch to Auto and back: terminals render normally
      on Auto. (A relaunch is what re-arms shared mode.)
- [ ] **5.3 No WebGL2.** On a machine/profile without WebGL2 (or with it disabled in flags):
      selecting Shared silently leaves every terminal on the DOM renderer — no error dialog, no
      blank terminals.
- [ ] **5.4 Unrecognised internals.** If any terminal warns `stays on the DOM renderer: xterm
      internals not recognised`, note it: that node keeps working (DOM), but it means the addon's
      assumptions broke on this xterm version.
- [ ] **5.5 No console noise.** Over a full session in shared mode, the console shows no repeated
      glyphgrid warnings (each warn is once-per-node-per-reason by design).
- [ ] **5.6 Soak — the macOS compositor.** Run shared mode **≥30 minutes** on the Mac with several
      busy terminals: watch for whole-window flicker or black-composited nodes (the exact macOS
      compositor failure class that motivated `WEBGL_BUDGET_DESKTOP_MAC=10` and the `'auto'`→DOM
      rule — this run is what tests the branch's central platform hypothesis that ONE context
      avoids it). Any occurrence = **do not promote beyond experimental**. Note the elapsed time,
      the terminal count, and whether the machine was on an external display, since the earlier
      reports had no console error to correlate against.

## 6. Regressions (the modes everyone else is on)

- [ ] **6.1 Auto.** Everything in §2/§3 that applies, on Auto: unchanged from `main`.
- [ ] **6.2 GPU per terminal.** Contexts are granted/reclaimed on pan and zoom exactly as before
      (zoom out past the suspend threshold → no contexts; zoom in → re-granted).
- [ ] **6.3 Off.** Every terminal on the DOM renderer, no WebGL contexts at all.
- [ ] **6.4 Settings round-trip.** Pick each of the four options, quit and relaunch: the choice is
      still there (`settings.json` holds `"terminalGpuRendering": "shared"` etc.).
- [ ] **6.5 Hand-edited garbage.** Set `"terminalGpuRendering": "warp-speed"` in `settings.json`
      and relaunch: the app comes up on **Auto**, not on an experimental mode.
- [ ] **6.6 Server Edition sanity.** (Optional, Linux/browser.) The Terminal rendering row exists
      and Auto/On/Off behave as before; Shared is expected to work but is not part of this gate.

---

## Known limitations (accepted for Phase 1b — verify they are what you see, not that they are absent)

- **L1 — The cursor does not blink.** The shared renderer paints a static block cursor regardless
  of the "Cursor blink" setting. Decide on device whether this ships as-is or the setting should be
  gated in shared mode.
- **L2 — A blurred terminal paints no cursor.** xterm's DOM renderer draws a hollow outline for an
  unfocused terminal; the engine has no outline flag, so the cursor simply disappears on blur.
- **L3 — Selection does not dim on blur.** The theme lanes carry no *inactive* selection color, so
  an unfocused terminal's selection keeps the active color.
- **L4 — Square plate corners.** The grid's plate is a rectangle; the node has `border-radius: 10px`
  and cannot clip the canvas (it is not a DOM child), so the body's corners read square in shared
  mode. Phase 2: rounded/stencilled plate.
- **L5 — FIXED in round 2 (bands at the bottom/right).** Kept here as the record, because it is the
  one item on this list whose expected observation INVERTED. It used to read: the plate covers the
  grid plus one scalar of host padding (`padPx`, the 6px max of `.term-node__xterm`'s asymmetric
  padding), so every band of body the cell fit does not fill shows the canvas dot grid through the
  transparent node — as (a) up to one cell of **fit slack** at the right/bottom, and (b) the
  **letterbox** bands of a co-attached node, tens of pixels wide. Both were reported from the
  device. The plate is now an INDEPENDENT world rect set to the node **body** (`GridSpec.plateX/Y/
  W/H` ← `bodyPlateRect`, pushed on the ResizeObserver's settled tick and carried by the position
  effect during a drag), so it covers the padding, the fit slack and the letterbox bands alike —
  they all lie inside the body box. Verify by items **2.4**, **2.13** and **3.11**: a band now means
  the plate is not TRACKING the body (a bug), not that it is undersized by design.
  **L4 is unaffected and remains** — the plate's square corners are a separate Phase-2 question
  (a rounded / stencilled plate), and no rect size fixes them.
- **L6 — Adopting a parked terminal after a font change may keep a stale cell size.** The grid is
  registered from the cell xterm reports at adopt time; a font change applied in the same commit
  can land after it. Refreshing the node re-registers at the correct size.
- **L7 — Group-parented z is an approximation.** The paint order is the node array order with
  selected nodes elevated (mirroring React Flow's `elevateNodesOnSelect`); React Flow additionally
  gives a grouped node `parentZ + 1`, which the order signature does not model. Overlaps that mix
  grouped and ungrouped terminals can therefore order differently from the DOM.
- **L8 — The kanban card modal stays on xterm's DOM renderer, by design in v1.** The modal is a
  second, co-attached view of the same tmux session living outside the canvas' coordinate space;
  it has no grid, no camera and no z in the shared canvas. Board parity here is a Phase-2 question.
- **L9 — A failure is permanent for the session.** A GL error or a lost context disables the shared
  renderer until the app is relaunched; there is no restore path in Phase 1b (deliberate — a retry
  loop on a bad driver is how you turn one failure into a flicker).
- **L10 — The atlas is not rebuilt on a dpr change.** Moving the window to a display with a
  different dpr leaves the glyphs rasterized for the old one (slightly soft or over-sampled).
  Geometry is unaffected — the drawing buffer follows the dpr on every resize.
- **L11 — Grids keep drawing while the kanban board covers the canvas.** The board overlay is
  opaque, so nothing is visible; it is wasted work, measured by item 4.16 and closed in Phase 2 if
  it shows up.
- **L12 — Terminal search (⌘F) finds, counts and scrolls, but the match HIGHLIGHTS are invisible.**
  xterm's search addon marks hits as *decorations*, which are painted by the active renderer at
  cell level; the shared feed carries cells and theme lanes only, with no decoration input, so the
  engine has nothing to draw. Search itself is unaffected — the addon still walks the buffer, the
  `n of m` counter is correct, and each hit is scrolled into view — you simply cannot see which
  cells matched. Phase 2 (a decoration lane in the feed).
- **L13 — The block cursor on a double-width glyph paints only the left half-cell.** The cursor rect
  is emitted at one cell's width, while a CJK/emoji cell occupies two columns, so the block covers
  the left column and the right half of the glyph stays uncovered. Cosmetic and position-correct
  (the cursor is on the right cell); Phase 2, with the same wide-cell geometry work as the rest of
  the plate/rect family.
- **L14 — The atlas cell and the baseline latch to the FIRST terminal's usable measurement.** The
  atlas is rasterized into xterm's own `dimensions.device.cell`, handed over by whichever terminal
  builds the shared context first, and the baseline is derived from that same font at that moment.
  Two consequences. A **webfont that resolves later** leaves the atlas on the fallback face's
  metrics for the life of the context — the text is measured and placed correctly, just against the
  wrong face's cell — until something disposes the context (a font-family/size change in Settings;
  L10's dpr change does not). And a terminal whose device cell **diverges** from the atlas's (a dpr
  change under a live context, a per-terminal letterSpacing) has its glyphs resampled against the
  quad they are drawn onto, i.e. slightly soft — never misplaced. Both are announced:
  `warnOnCellDrift` logs one `[glyphgrid] atlas cell … does not match …` line per context lifetime,
  so a soft terminal can be told apart from a soft display. Phase 2 (re-rasterize on
  `document.fonts.ready` / per-cell atlas pages).

---

## Result

- Date / machine / OS / display setup:
- Blocking findings:
- Non-blocking findings (with the item number):
- Verdict: ship experimental / hold
