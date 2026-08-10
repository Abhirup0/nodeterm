# GlyphGrid — device acceptance checklist (the promotion gate, and the regression list after it)

**This document was the acceptance gate for the shared terminal renderer, and it is now the
regression checklist for the mode that is the DEFAULT on macOS.** It was written for Phase 1b,
extended by every Phase 2 task that changed behaviour it describes, and run in full — together
with the §5.6 soak — before `auto` was promoted to the shared renderer on macOS (2026-08-05).
The parts that matter most — WebGL2, xterm's internals, layout, fonts, IME, the macOS compositor —
have no coverage in the (node-environment) test suite by design. Nothing here can be verified in
CI; everything here has to be seen on a real machine.

Re-run it on the Mac whenever the engine or the attach shell changes, on a project with **at least
a dozen terminals** (agent CLIs streaming output, not idle shells). Tick each box only when the
stated observation is what actually happened; note anything else inline. Items marked **[1a]**
re-run the Phase 1a acceptance so a regression in the engine is caught before the integration is
judged. Since macOS `Auto` now resolves to Shared GPU, a failure here is no longer confined to an
opt-in mode: it reaches every Mac user who never touched the setting.

Setting: **Settings → Terminal → Terminal rendering**
(`Auto (default)` / `GPU per terminal` / `Shared GPU` / `Off (DOM renderer)`).

**Before you start — the setting is one-way against older builds.** `"shared"` is a value only this
branch knows: running an OLDER build against the same data dir (the released desktop app, or a
Server Edition still on `main` pointed at that `settings.json`) validates the unknown value away and
**permanently rewrites `"terminalGpuRendering": "shared"` back to `"auto"`** on its next settings
save. This is safe — it degrades to the default renderer, nothing is lost but the choice itself —
but it is silent and not undone by relaunching this branch, so if a checklist item suddenly reads
Auto after you switched builds, that is why: re-select Shared and carry on.

---

## 1. Setup and baseline

- [ ] **1.1 The default IS the shared renderer (macOS).** Fresh launch with an existing
      `settings.json` that never set the row: it reads **Auto (default)**, and the canvas comes up
      on the SHARED renderer — **exactly one** WebGL2 context for the whole page, terminals showing
      text immediately, no per-terminal contexts. (Auto is the only mode most users will ever be
      on. A Mac landing on the DOM renderer or on per-terminal WebGL means the promotion did not
      take; a terminal that is blank, black or unreadable on Auto is a **release blocker** — revert
      `resolveTerminalRenderer`'s macOS branch to `'dom'` rather than ship it.) Off macOS, Auto is
      still per-terminal WebGL and must be unchanged from `main`.
- [ ] **1.2 The row is a select, not a switch.** Four options in this order: Auto (default) /
      GPU per terminal / Shared GPU / Off (DOM renderer). No option says "experimental". The
      description says Auto uses Shared GPU on macOS, describes what the three modes do, and still
      states that Shared GPU "falls back to DOM on failure". Settings search for "gpu", "webgl",
      "shared" and "experimental" all find the row (the last is kept as a search word on purpose,
      for users who remember the old label).
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
- [ ] **2.2b Box drawing and block art (round 4).** The item the round-3 screenshots failed. Draw a
      table or a framed TUI (`claude` / `codex` panels, `htop`, `tmux` borders, `lsd --tree`) and a
      piece of block art (the nodeterm mascot, `▀▄█▌▐`, a `░▒▓` ramp). Expected now that these two
      ranges are drawn GEOMETRICALLY instead of with the font (`box-glyphs.ts`):
      **separators are continuous** — a run of `───` shows no gap at any cell boundary, and corners
      and tees join their arms with no notch; **block elements tile exactly** — `▀`/`▄` and
      `▌`/`▐` meet on a shared edge with no dark seam and no overlap, the eighth blocks step
      evenly, and the mascot is the right shape with no dark artifacts; the shade ramp `░▒▓` reads
      as three distinct densities. **Look at `░▒▓` up close**: they must be DITHER patterns (a
      visible stipple of single device pixels, transcribed from xterm's own pattern table), not
      smooth tints — a flat wash means the geometry path regressed to an alpha fill and will not
      match the renderer beside it. Known v1 approximations, not defects: **rounded corners
      `╭╮╯╰` render SQUARE**, the diagonals `╱╲╳` still come from the font, and the double-line
      tees `╠╣╦╩` keep the crossing rail continuous where the printed glyph breaks it.
      Also run an agent CLI and check its tool-result connectors (`⎿`) and any `⎾ ⎯ ⏐`
      line-extension pieces: the elbow's foot must be FULL WIDTH, matching GPU mode. A stub foot was
      the 2026-08-04 device finding — those four Misc-Technical code points are now drawn
      geometrically as aliases of `└ ┌ ─ │` instead of being drawn by the font and clipped to the
      cell. (`⎸ ⎹` are deliberately still font-drawn; see L16.)
      The round-3 report's "blockier / heavier than GPU mode" should be GONE for line and block art.
      If PLAIN TEXT still reads heavier or softer than the per-terminal GPU renderer, that is a
      **separate finding** — file it against 2.2/2.7, not here, since nothing in this change touches
      how ordinary glyphs are rasterized.
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
- [ ] **2.7 Zoom-1 parity at dpr 1 and 2 (rewritten for Phase 1c — parity is now STRUCTURAL).**
      Everything this item used to ask about a blend is gone, and so is the blend. Each atlas slot
      now holds the platform's own rasterization of one glyph **in its real foreground over its real
      background** — the same thing xterm's `TextureAtlas._drawToCache` builds for the GPU renderer
      you are comparing against — and at zoom 1 that slot is blitted **1:1** onto the cell: the atlas
      is rasterized at xterm's exact device cell, `MIN_FILTER` is NEAREST at zoom ≥ 1 (MAG always
      is), and the pan is snapped to whole device pixels. There is no coverage encoding, no shader
      mix and no gamma constant left in the pipeline — **`BLEND_GAMMA` and the linear-light blend
      were DELETED, not retuned.** The acceptance question changed with them: it is no longer "is the
      weight right", which was a knob, but "are these the same pixels", which is a fact.
      **How to run it.** On the retina display and on an external 1x display, with a non-default font
      family and size (e.g. Menlo 11, JetBrains Mono 16), at zoom exactly 1, put a Shared terminal
      beside a **GPU per terminal** one running the same content. Judge a paragraph of prose,
      `man bash`, and a source file — and specifically the cases the colour keying introduced: bold,
      italic, dim, inverse, ANSI-coloured output, a selection band, and a block cursor sitting on a
      character.
      **What to report.** Any visible difference, and WHERE it lives: which glyphs, which colours,
      which dpr, plain vs bold/dim/inverse. A remaining gap can no longer be a blend setting, so
      "slightly thicker" / "slightly thinner" is no longer an actionable answer — the candidates left
      are the raster (baseline rounding, the ink clip at the cell rect) and L14's first-terminal cell
      latch, and those are found by knowing which glyphs are wrong, not by which way.
- [ ] **2.7b One letter renders BLANK (open bug — this round collects EVIDENCE, not a fix).**
      Reported twice: `ç` in round 5 (which "went away" with no root cause found) and lowercase `x`
      in round 7 — one letter blank all session while its neighbours, including uppercase `X`,
      render fine. Every headless-auditable path has been audited and is clean: `boxGlyphOps`
      claims no code point below U+0300 and never returns an empty op list (so the
      "claimed-but-drew-nothing" blank is ruled out); `raster.draw` clips, re-blacks and inks in
      that order on BOTH branches; `cellXY` is the single copy of the layout math and the vertex
      shader recomputes it identically; `strideX = ceil(cellW) >= cellW` always, and the
      rasterizer's cell is captured at construction and never re-adopted, so ink can never overflow
      into a neighbour's slot; and the rAF driver calls `frame()` every frame, so a newly
      rasterized glyph cannot miss its upload. Reproducing needs a real font on a real device.
      **How to run this item:**
      1. In DevTools: `localStorage.setItem('nodeterm.glyphgridDebug','1')`, then reload.
      2. Use the app until a letter goes blank. Note **which** letter, and whether its
         uppercase/lowercase/bold/italic variants also fail.
      3. Run `await window.__glyphgridDump()` and open the returned `page` data URL in a new tab —
         that is a PNG of the whole atlas. **Find the reported letter in it.** Since Phase 1c the
         page is COLOURED, which changes how it reads: each cell is that glyph over its own
         background (a dark theme gives a mostly dark-on-dark page), the ground between allocated
         slots is TRANSPARENT rather than black (so it shows as the tab's own backdrop), and the same
         letter legitimately appears once per colour pair it has been drawn in.
         - **Not in the atlas (its cell is an inkless expanse of its own background colour)** → the
           RASTERIZER is the suspect (font, baseline, clip). Report the letter plus the
           `[glyphgrid] slot … code … at x,y fg=… bg=…` warn line for it.
         - **In the atlas, correctly drawn** → the slot→uv mapping or the texture upload is. Report
           its slot number and the `geometry` block from the dump alongside the PNG. `geometry` also
           carries `gutterPx` (a slot's ink starts one gutter inside its pitch cell, so stride
           arithmetic alone lands a couple of texels off) and `resetCount` (a slot INDEX only means
           something alongside the reset it was taken after — see 2.7c).
      4. Paste the console's `[glyphgrid]` lines for the letter and its working neighbours.
      This instrumentation is temporary and comes out when the bug closes.
- [ ] **2.7c Zoom-OUT quality (new in Phase 1c — the other half of the parity ask).** Keep the
      side-by-side from 2.7, then zoom the canvas out to roughly **50%** and again to roughly **25%**
      and compare the Shared terminals against the GPU-mode one at each stop. Pan while zoomed out —
      motion is where undersampling shows.
      **What should now be true.** Minified text degrades SMOOTHLY, in the same class as GPU mode:
      softer as it shrinks, but not speckling, crawling or shimmering under a pan. The atlas carries
      a real mip chain and every slot carries a 2-texel gutter holding its own edge-extended content,
      so a minified sample averages texels that belong to this cell instead of undersampling level 0
      — which is exactly what made a zoomed-out canvas sparkle before this phase.
      **Also check FULL-BLEED art, not just text (fixed after the 2026-08-04 device round).** Put
      something made of solid blocks on screen — the **Claude mascot** (the `claude` splash art,
      U+2580–U+259F) is the reference case — and keep a **tmux pane split** in view so its `│` `─`
      separators are there too. At ~50% and ~25%: the mascot must read as SOLID, with **no dark
      "grout" lines along the cell boundaries**, and the separators must stay continuous rather than
      going dashed. Before the gutters were edge-extended, every cell boundary grew a dark seam — the
      mip texel was averaging the cell's edge INK with the slot's flat background gutter — so a solid
      block of mascot came out as a dark lattice. Seams coming back is a **blocking** report: say at
      which zoom, and whether the dips track the cell pitch.
      **Expected residual 0a — two adjacent full-bleed slots.** At the worst subpixel phase and mip
      level 2, a bilinear tap reaches a gutter texel blending THIS slot's edge colour with the
      NEIGHBOUR's — **up to 25%** of the sampled value. Where two differently-coloured full-bleed
      cells sit side by side, each can therefore tint the other's outermost sample by that much.
      Same weight as before this change (it used to be 25% of the neighbour's *background*), so it
      is the same bounded, accepted class — a faint tint at extreme zoom-out, never a seam and never
      a ghost glyph. Report it only if it reads as more than that.
      **Expected residual 0b — a fractional device cell, FONT-RENDERED full-bleed glyphs only.**
      A device cell is `charWidth * dpr`, so at most dprs one or both axes are FRACTIONAL and the
      cell's outermost texel is only partly covered — an ink/background blend that belongs to the
      cell and cannot be filled in from outside. Edge-extending the gutter from the last FULLY
      covered texel brought that boundary dip down from 62.5 points (flat bg gutter, the reported
      bug) to 12.5, and the second device round measured what was left: 4–38 points, phase-dependent,
      on the fractional axis.
      **GEOMETRIC box/block art is now seam-FREE — the mascot and the tmux separators included.**
      Since the 2026-08-04 far-edge snapping, a box/block op whose span reaches the cell's far edge
      is grown to the whole texel, so the partial texel is fully inked and the gutter continues real
      ink: the residual on the geometry path is **zero**, at every phase. Anything that still reads
      as grout on block art or on `│` `─` is a **blocking** report, not this residual.
      What remains is the same partial texel under a glyph the FONT drew, where the blend is genuine
      antialiased glyph edge and overwriting it would corrupt real pixels. That is rare in practice
      — everything in U+2500–U+259F that `box-glyphs.ts` has an entry for goes through the geometry
      path — and it takes a full-bleed glyph from outside those tables to see it at all. If you do:
      a barely-perceptible softening on the fractional axis, never a dark line. A visible dark line
      is the blocking report — note the display's dpr and whether it appears on one axis or both.
      **Also check block art at ZOOM 1 while you are here, not only zoomed out.** Far-edge snapping
      changes what the boundary texel holds, so it changes the 1:1 blit too. At an ink|ink boundary
      (block interiors, a run of `─`) the snap makes the zoom-1 sample exactly right. At a
      SILHOUETTE edge — where block art meets background — expect it to read marginally HARDER than
      before: both spellings approximate a partly-covered pixel, and the difference is under one
      pixel of coverage. Harder-but-clean is this change. A silhouette that looks NOTCHED, stepped
      by a whole pixel, or that shifts the art's outline by a visible amount is a finding.
      **Expected residual 1 — the LOD clamp.** The sampler is forbidden to go deeper than mip level 2,
      because that is the deepest level the gutter can keep free of a neighbouring glyph's ink. Past
      roughly 25% the filter therefore cannot get any softer, and slight aliasing comes back. That is
      the accepted trade — a little aliasing at extreme zoom-out instead of a neighbour's glyph
      bleeding into every cell — and it is not a finding.
      **Expected residual 2 — the frontier rim.** While the atlas page is still FILLING (a young
      session, or the frames right after a reset), the mip average at a slot's outer edge includes
      unallocated, transparent page ground. The texture is non-premultiplied, so rgb and alpha are
      averaged independently and the blend then attenuates the already-darkened colour by that same
      alpha again: the outermost row/column of the affected cells reads as a slightly **DARKER,
      slightly TRANSLUCENT rim** at heavy zoom-out (~25%) — you can see the node's plate through it.
      It is bounded to one cell edge, purely cosmetic, and **self-heals as the page fills**. **Do not
      diagnose it as a gutter/bleed failure**: bleed would look like a NEIGHBOURING GLYPH appearing
      inside a cell, which is a different — and blocking — report. If the rim is objectionable in
      practice, say so and say at what zoom and how long into the session: the named escalation is
      uploading the atlas premultiplied (`pixelStorei(UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)` with
      `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`), which is gated on exactly that device evidence and
      deliberately not built yet.
      **Atlas resets, while you are here.** The colour-keyed page is a working set — one slot per
      `(code, style, fg, bg)` — so filling it is normal, and the answer is to clear it and repack
      every row. On screen that is ONE frame of full repaint across the shared terminals: a flicker
      at most, never a blank. Each reset announces itself:
      `[glyphgrid] atlas page reset #N — colour key space full, every row repacks`, throttled to one
      line a second, a burst adding `(+K more since the last line)`. **Report the highest `N` you saw
      and roughly how long the session had run to get there.** "Rare" is this design's claim; frequent
      resets are the evidence that Phase 2 must build real LRU eviction instead.
      **If every shared terminal's TEXT goes BLACK the moment you zoom below 100% (and comes back at
      100%+), that is the mip pyramid clamp** — `TEXTURE_MAX_LEVEL` at the atlas upload in
      `gl-webgl2.ts` is spec-correct but untested on this GPU, and a driver that disagrees about
      mipmap completeness samples black below zoom 1. Loud, unmistakable, one-line revert: delete the
      `TEXTURE_MAX_LEVEL` `texParameteri` call (the full pyramid comes back; `TEXTURE_MAX_LOD` still
      clamps sampling). Report it rather than living with it — the revert costs ~0.35 MB per page.
- [ ] **2.8 Selection visual.** Drag-select inside a terminal: the selection band covers exactly
      the selected cells, with correct fg/bg inversion, and matches what the DOM renderer draws.
- [ ] **2.9 Cursor.** A focused terminal shows a cursor at the right cell (a solid block, with the
      default setting).
      **Blink.** With Settings → Terminal → "Cursor blink" ON, the cursor of the FOCUSED terminal
      flashes at xterm's own rate (600 ms shown, 600 ms hidden) while every other terminal on the
      canvas holds a steady shape; with the setting OFF it is rock steady. Then check the three ways
      it can STOP, each of which must leave the cursor **shown** rather than stuck invisible: turn
      the setting off while it happens to be in its hidden phase, click from one terminal into
      another, and open the kanban board (⌘⇧B) and come back.
      **A block cursor blinks as a whole cell and every other shape as a hairline overlay — walk at
      least one of each** (Settings → Terminal → Cursor style), because the two are drawn by
      different halves of the renderer and a phase that hid only one would show as a cursor that
      goes hollow instead of away, or as an inverted cell with no mark on it. A cursor that is
      **static** with the setting on is a BUG now (the wiring is complete); report it with which
      shape was selected and whether the terminal had focus. See 4.19 for the frame cost this must
      not have.
      **Typing holds the cursor SOLID**, the way xterm's own does: type a slow sentence into a
      shared terminal and the cursor must not flash under your keystrokes — each one restarts the
      period. The point of this check is the comparison, so do it beside a **stacked** terminal (one
      node overlapping another, which leaves the shared canvas for xterm's DOM renderer — L15): the
      two cursors must behave the same, both while typing and while idle. A shared cursor that keeps
      flashing while you type is the drift the matched 600 ms period exists to prevent.
      **The cursor honours Settings → Terminal → Cursor** (the row's segmented control, beside the
      `blink` switch). Walk all three: `block` INVERTS the
      glyph under it (the letter goes dark on a bright cell — a block is drawn as a CELL, and that is
      the only path that can invert), `bar` is a hairline down the LEFT edge with the glyph still
      readable beside it, `underline` is one along the bottom. Change the setting while the terminal
      is focused: the shape follows immediately, with no refresh. Then **zoom out to ~30% and back**:
      a bar/underline stays a visible hairline at every step (its thickness is held at one device
      pixel), never fading away and never growing into a block.
- [ ] **2.10 Cursor at end of line.** Type until the cursor sits past the last column (deferred
      wrap): the cursor is drawn on the LAST column, not off-screen or on the next row.
- [ ] **2.11 Cursor hidden by a TUI.** Open a fullscreen CLI that hides the cursor (any agent CLI,
      `less`, `htop`): no stray block cursor is painted anywhere on the grid.
- [ ] **2.12 Blur.** Click away from a terminal. Two things change, and both are the point of the
      item: the block cursor becomes a **hollow outline** — a one-pixel box around the cell with the
      glyph inside it readable, which is exactly what xterm's DOM renderer draws for an unfocused
      terminal — and a selection made before the blur is **dimmer** than it was, in the same hue.
      Compare a focused and a blurred terminal side by side; the two selections must be
      distinguishable at a glance. Then set Settings → Terminal → **When unfocused** to
      `none` (no cursor at all on blur), to `block` (a solid one, glyph inverted, on the blurred
      terminal) and back to `outline`. **The outline is the DEFAULT** — every terminal on the canvas
      except the focused one is drawing it, so judge it at normal zoom on a busy canvas, not only on
      one node.
- [ ] **2.13 Plate geometry, and the rounded corners.** Look at the four corners and the
      right/bottom edges of a terminal body. Expected: **no bands anywhere** — the plate is the body
      rect, so the fit slack at the right/bottom and the padding seams on the left/top are all
      inside it (the round-2 fix; the previous grid-sized plate is what put them there). The plate
      is a rounded QUAD now rather than a square clear, so the body's two **bottom** corners follow
      the node's own `border-radius` and no square shoulder pokes out past the node's curve. Put a
      shared terminal over something that makes the corner visible (a group frame, another node,
      the light theme) and check four things: the curve **matches the node's own chrome** — compare
      it with the rounded header at the top of the same node, and with a DOM-renderer terminal
      beside it, in BOTH themes; the corner is **smooth, not stepped**; the **straight** edges are
      still opaque edge-to-edge, with no half-lit hairline of canvas along them; and the **top two
      corners stay square**, which is correct — they sit against the opaque header/labels row and
      are not corners on screen, so rounding them would carve a notch of canvas out of the body.
      Then **zoom out to ~0.3 and in to ~3**: the corner keeps its proportion at every zoom, and it
      never inverts into a corner-shaped hole. The half-side radius clamp (`plateRadiusDevice`) is
      **defensive and NOT reachable through the UI — do not try to produce it**: a node's body
      bottoms out around ~120 world px (`NodeResizer minHeight={160}`) while the clamp engages below
      ~18, and zoom cannot get there because the radius and the shape are measured at the same
      scale. Report any band you still see —
      a band now means the plate rect is not tracking the body, not that it is undersized by
      design. **Judge bands only AFTER a resize gesture settles.** The plate is re-pushed on the
      ResizeObserver's coalesced tick (80 ms after the last resize event — the same settle the
      terminal reflow waits for), so dragging a node's edge OUTWARD shows a transient band that
      closes when you let go. That is expected; a band that survives the settle is the defect.
- [ ] **2.14 Scroll area after a font change.** Change the font size while shared is on, then look
      at the scrollbar/scroll area geometry: the thumb matches the content, no phantom region.
- [ ] **2.15 Cursor on a wide glyph.** Put the cursor ON a double-width character (type `日本語`
      and walk the cursor back over it, or `vim` with the cursor on an emoji). The block covers
      **both columns** — the whole character, with no un-inverted right half — and walking off it
      leaves nothing behind. Repeat with **Cursor style = underline** (the rule runs the full width
      of the character, not half of it) and with the terminal **blurred** (the outline boxes the
      whole character). `bar` is the deliberate exception: it stays ONE hairline on the left edge,
      because it marks the insertion point rather than the cell. Since 2026-08-05 the right half
      carries INK as well as background, so check that the inversion covers the **glyph**, not just
      the block behind it — an un-inverted right half of 日 now means the follower's slot was keyed
      on the wrong colours.

- [ ] **2.16 A double-width character is WHOLE — in EVERY renderer.** The 2026-08-05 report had two
      faces and one cause: shared showed ⭐ as a fragment, GPU/DOM showed 👍😄 overlapping the next
      character. xterm was measuring on the **Unicode 6** table, where every emoji is ONE cell wide,
      while tmux and the agent CLIs measure on a modern one where they are two (see
      `terminal/unicode-width.ts`). A renderer cannot draw a two-cell character correctly while the
      buffer insists it is one cell.

      Print a row of wide characters — `printf '⭐ 👍 😄 🎉 日本語 中文\n'` — and look at it in
      **all three** renderer settings (Shared, GPU per terminal, Off). In each: every character is
      complete, nothing overlaps its neighbour, and the two halves **meet without a step** — no
      background seam down the middle, no offset, no doubled left half. Repeat with **bold**
      (`printf '\033[1m⭐ 日本語\033[0m\n'`); a bold left half beside a regular right half is the
      failure. Expected residual in SHARED only: the seam may show a hairline antialiasing
      difference, because the two halves are rasterized at different sub-texel phases (`inkX` in
      `raster.ts`). A hairline is the accepted cost; a visible break or a colour seam is not.
      Characters wider than two cells are still cut — that is L16, unchanged.

- [ ] **2.17 Column alignment after an emoji — the reason 2.16 matters.** Widths are not a looks
      question: tmux repaints by ABSOLUTE cursor position, so if it and xterm disagree about how
      many columns a character spans, the two screen models drift apart for the rest of the line and
      a partial repaint can leave a column blank or doubled well away from the emoji. Run
      `printf '⭐x⭐x⭐x\n123456789\n'` and check the `x`s line up with the digits they should; then
      resize the node and confirm nothing shifts. **The real test is an agent session** — run one
      that prints emoji and watch for a letter going missing mid-word, which is the other
      2026-08-05 report and a live candidate for the same cause. If misalignment appears **after**
      this change, that host's tmux is the one on the old table (a build without utf8proc) — report
      it as such; the fix is that tmux, not a return to Unicode 6.

- [ ] **2.18 A symbol wider than its cell is COMPLETE, not sliced.** The other half of the
      2026-08-05 round: an agent CLI's task-list icon rendered with its right edge cut off in
      Shared while GPU mode drew it whole. Ink overflowing a cell used to be clipped (and the clip
      cannot be relaxed — see L16); it is now SHRUNK to fit. Run an agent CLI and look at its task
      list, its tool-result connectors and any status glyphs, then compare the same line against
      **GPU per terminal**: no glyph may have a straight vertical edge where its shape should
      continue.
      **Expected difference, not a defect:** an oversized symbol renders slightly SMALLER here than
      in GPU mode, which overhangs into the neighbouring cell instead. Smaller-and-whole is the
      trade. Report anything still SEVERED, and report a glyph that shrank so far it is hard to
      read (that is `MIN_INK_FIT_SCALE` set wrong, not the mechanism failing). Ordinary text must
      be untouched — if plain Latin text looks smaller or unevenly sized after this, the tolerance
      is misfiring and that is a **release blocker**. That is not hypothetical: between 2026-08-05
      and 2026-08-07 the shrink applied to LETTERS too, and since an italic face's worst glyph
      measures ~1.19 of its advance (bold-italic ~1.25) it rendered italic text at ~84% of the
      roman text beside it — per glyph, so narrow letters stayed full size and wide ones did not.
      **Check a paragraph of italic and bold-italic markdown** (agent output is full of it): every
      letter the same size as its neighbours, and the same size as the roman text around it.

- [ ] **2.19 Underline — the attribute AND the hovered link.** Until 2026-08-05 shared mode drew no
      underline at all: the feed wrote the flag and nothing read it. Two things to check, because
      they are two sources of one mechanism.
      **The attribute:** `printf '\033[4municn underlined text\033[0m\n'` — one continuous rule under
      the whole run, spaces included (a rule that dashes at word gaps means the blank cells are
      short-circuiting again), joining cleanly across cell boundaries with no gaps, and the same
      weight as GPU mode's.
      **The link:** hover a URL with ⌘ held (an agent CLI's login URL is the reported case) — the
      underline appears under the WHOLE link, including its last character, and disappears when the
      pointer leaves. Move the pointer between two links on one line and confirm the old one clears.
      A link that wraps across rows is underlined on every row it covers.

- [ ] **2.20 Crispness at a zoom that is NOT exactly 1.** The 2026-08-09 report ("text isn't so
      crisp, might be related to retina") was taken at zoom **0.976** — and a canvas is very rarely
      at exactly 1, since any pinch, fitView or window resize lands on a number like that. The
      sampler used to jump to trilinear mip filtering the instant zoom fell below 1, blending a
      half-resolution mip into every glyph to pay for a 2.4% minification.
      Pinch to a hair under 1 (0.95–0.99) and compare against **GPU per terminal** at the same
      zoom: the text must read as sharp, not softened. Then zoom OUT properly (0.5, 0.3) and check
      the opposite failure — the mip chain is still what stops a zoomed-out canvas shimmering, so
      speckle or crawling stems there means the band went too far. `atlasFilterChoice` is the rule;
      0.9 is the boundary between the two.

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
- [ ] **3.9 Selecting / raising the LOWER of two overlapping terminals (REWRITTEN in round 5).**
      Round 4's trade — selection stopped elevating anything while Shared was on — is **REVERTED**.
      Selection elevation is back on in every renderer mode, and what changed instead is that a
      terminal which sits over another node **leaves the shared canvas** and renders on its own DOM
      renderer for as long as it is stacked (L15). Confirm the ordinary behaviour is ordinary:
      click the partially-covered terminal → it comes to the FRONT, chrome and contents together,
      and nothing of the node it now covers is visible through it. Click the other one → they swap,
      cleanly, with no intermediate frame in which both are legible in the same rectangle. Drag one
      over the other and back: the same, throughout the gesture and after it settles. **Watch the
      DROP specifically** — the frame at which the mouse is released is where the previous build
      flashed the dropped node transparent over what it had landed on (the set is now computed
      during Canvas's render, so the node learns it must stay opaque in the very render that ends
      the drag). Also create a NEW terminal on top of an existing one, and reload a project whose
      nodes already overlap: neither may flash transparent on arrival.
- [ ] **3.9e Group drag and node resize (round 5).** Two gestures that are not a plain node drag:
      (a) drag a GROUP FRAME containing terminals across other nodes — the terminals inside must be
      opaque for the whole sweep (React Flow never marks a dragged frame's children `dragging`, so
      this is covered by an ancestor walk, and it was the worst case: a frame sweeping transparent
      terminals across the canvas); (b) grab a terminal's resize handle and drag it over a
      neighbour — same expectation, and on release it must settle to the correct answer for its new
      size. In both, the canvas must not visibly churn (terminals flickering between crisp and soft)
      during the gesture: the set is frozen for its duration and recomputed once on the settle.
- [ ] **3.9c Node-attached UI that escapes the node box (round 5: the round-4 trade is GONE).** The
      💬 comments flyout (`.term-node__comments`) and the kanban column half-pill (`ColumnPill`) are
      positioned OUTSIDE their node's rect. With selection elevation restored they are lifted with
      their node again, so: open a flyout on a terminal that another terminal overlaps, click the
      node — the flyout must come to the front with it and be fully readable and clickable. Same
      for a session node's column pill. Anything covered here is a defect now, not a known trade.
      **The one case that is NOT covered and must not be filed:** the opposite direction — a
      NEIGHBOUR's flyout or pill overhanging a *glyph* terminal. The rule compares node RECTS, and
      these two surfaces are deliberately outside their node's rect, so a neighbour's overhang can
      show through a transparent body. Known, stated in L15, Phase 2.
- [ ] **3.9d Ephemeral cards over a glyph terminal (NOT a defect — confirm and move on).** With a
      Claude node running subagents (or a /loop card up), drag the parent terminal so a subagent
      card lands over ANOTHER terminal's body. The card may be visible through that terminal: the
      ephemeral cards live outside Canvas's `nodes` array by design, so the opaque rule cannot see
      them (L15). Note whether it looks broken enough to matter — that judgement is the point of the
      item, not the artifact itself.
- [ ] **3.9b Overlap, the whole of it (round 5).** With two terminals overlapping, look at the
      covered region closely. Expected: the upper node hides the lower one **completely** — no text,
      no cursor, no selection band, **and no frame hairline**. Round 4's L15 ghost (the lower node's
      1px border showing through the upper node's transparent body) is gone, because the upper node
      is not a transparent body any more: being stacked put it on the DOM renderer, opaque, with
      native stacking. **Report ANY trace of the lower node inside the upper node's box as a
      defect.** The expected tell that this is working is the opposite one: the upper node's text
      may look very slightly softer than its un-stacked neighbours' at zoom ≠ 1 (DOM renderer vs
      GPU glyphs). Note whether you can see that difference and how objectionable it is — that is
      the round-5 question. Also: move the nodes apart again and confirm the upper one goes BACK to
      the shared canvas (its text sharpens up) once they no longer overlap.
- [ ] **3.10 Group-parented terminal, and terminals ON a frame (L7 is now modelled — round 5).** A
      terminal inside a group frame: its text sits exactly in its body (the offset chain resolves
      through the parent). Then the two stacking cases the z model exists for:
      (a) **drag an UNGROUPED terminal over a populated group frame.** It paints on top of the frame
      (a frame is z 0, tied with ungrouped nodes, and frames sort first), so it must go opaque —
      **no part of the frame's dashed border, and no part of its label pill, may be visible inside
      that terminal's body.** This is the case a wrong z model leaves transparent, and it looks
      exactly like the frame-ghost round 5 deleted, so report it precisely.
      (b) **overlap a grouped terminal with an ungrouped one.** The grouped one is above (child z 1
      vs 0) regardless of which was created first: it must hide the ungrouped one completely, and
      clicking either must still bring it to the front.
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
      scrollback: matches are found and scrolled to, the counter (`n of m`) is right, **the matched
      cells are HIGHLIGHTED, and the highlight follows next/previous** (the active hit reads
      differently from the rest). Then, with the bar still open, scroll the viewport: the highlights
      stay on their own matches instead of sliding onto other rows. Close the bar: every highlight
      goes away, leaving no coloured cell behind. Select a run of text that covers a match — the
      selection band stays unbroken over it, and the cursor stays visible when it lands on a hit.

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
- [ ] **4.15 dpr change — the atlas is now REBUILT.** Drag the window between the retina display
      and an external 1x monitor, **both directions, and then back again**. Expected: geometry
      stays correct (the drawing buffer follows), and the text on the new display is as sharp as a
      terminal opened there fresh. Soft or over-sharp text after the move is now a FAILURE. It used
      to be documented behaviour — through Phase 1c the atlas was never rebuilt on a display change
      — and this item is what replaced that limitation.
      **What the rebuild costs, so it is not mis-filed as a bug.** It is the font-change path: the
      shared context is disposed and every terminal re-registers its grid. One repaint of the whole
      canvas at the moment of the move is expected, and a brief flash of DOM-rendered text is fine.
      A terminal left blank, transparent-but-empty, or stuck on the DOM renderer is not.
      **Report specifically:** any `[glyphgrid] atlas cell … does not match …` line in the console
      after a move. If a move produces NOTHING AT ALL — no repaint, text simply left soft or
      over-sharp — the trigger did not fire rather than the rebuild failing: two are wired, the
      window `resize` event and a `screen and (resolution: Xdppx)` media query (the one xterm
      itself relies on), so say which display pair and which direction. The re-registration is
      expected to read the NEW display's cell (the epoch bump
      tears the grid down first, which restores a DomRenderer that recomputes its dimensions against
      the live dpr), so that line means the rebuild adopted the OLD one and the sharpness is only
      half fixed. Also report whether the SECOND move rebuilds again or the fix latches after the
      first.
- [ ] **4.16 Kanban board — no frames are drawn under it.** Open the board over a shared-mode
      project: it is fully opaque (no glyphs showing through). Then the part this item exists for,
      which needs BUSY terminals, not idle ones — the idle park already covered idle.
      **How to run it.** With half a dozen terminals streaming (`yes`, a build, a busy agent),
      note the process CPU on the canvas, then open the board and watch it for ~30 s. Expected: it
      DROPS to roughly what the board costs on its own, and stays there — the loop is stopped, so
      the streaming rows cost nothing to draw. A canvas-level cost that stays flat when the board
      goes up means the gate never fired.
      **Then close the board, and watch the first paint.** Every terminal must show its CURRENT
      screen immediately — not the rows it had when the board went up, and not a blank body that
      fills in when the next line arrives. Stopping the loop stops drawing only; the grids keep
      receiving rows the whole time, so this is a repaint, and anything stale here is the bug.
      Also switch PROJECTS while the board is up (to a canvas-view project and back): the gate
      follows the active project, not just the view toggle.
- [ ] **4.17 Card modal.** Open a session's card modal while the canvas terminal is on the shared
      canvas: the modal's own terminal renders through xterm's DOM renderer (known limitation L8)
      and both views stay live and correctly sized.
- [ ] **4.18 Return from another application (stale grid origin).** Give an agent node a long job so
      it spawns subagents (the header gains the model chip + RUNNING badge), switch to another
      application for a minute or two, then come back: the terminal's text AND its background plate
      sit exactly inside the node body — not shifted down/right, with nothing spilling past the
      node's bottom edge onto the canvas or over the subagent cards. Reason: the 2026-08-04 device
      report, where exactly that happened and **dragging the node was the only way to heal it** (a
      drag re-registers the grid, which re-measures; nothing else did).
- [ ] **4.19 The rAF driver parks when the canvas is idle.** With shared mode on, leave a canvas of
      IDLE terminals (nothing streaming, no agent working, mouse still) for ~5 seconds, then look at
      Activity Monitor (the app's renderer + GPU processes) or DevTools' Performance/Rendering FPS
      meter: the frame pipeline goes QUIET rather than ticking at the display's refresh rate. Then:
      - type in one terminal → it repaints **immediately**, no perceptible first-keystroke delay
        (this is the `onDamage` wake, the mechanism);
      - pan and zoom the canvas → everything keeps repainting smoothly throughout;
      - switch to another application for a minute and come back → the canvas is live again
        (focus/visibilitychange wake).
      **The one expected exception to "quiet" is a blinking cursor** (2.9): with a terminal FOCUSED
      and "Cursor blink" on, the canvas ticks about TWICE A SECOND — one frame per phase flip,
      drawn through the loop's one-shot `pulse()` — and that is not a missed park. The FAILURE
      there is the opposite reading: an FPS meter at the display's refresh rate with nothing but a
      blinking cursor happening means the blink took the `wake()` path and is re-arming the 30-frame
      idle streak twice a second. Click into a terminal, leave everything else idle, and confirm the
      meter reads ~2 rather than 60. Then click AWAY (focus another app): the last phase leaves the
      cursor shown and the meter drops to quiet — a canvas with no focused terminal has no clock at
      all. **Typing is the other expected exception**, and it is the same mechanism: a cursor move
      holds the cursor solid and restarts the period, so the meter follows your keystrokes rather
      than flashing under them.
      **One innocent way to read 60 that is NOT a routing bug**, worth distinguishing before filing
      one: if the shared ATLAS resets during a blink repack, the addon asks xterm for a full redraw,
      and xterm's debounced render pass then packs rows from OUTSIDE the clock's bracket — which
      takes `wake()`, correctly. The atlas logs its resets (`resetCount`), so check the console
      before concluding the blink is on the wrong path.
      **BLOCKING symptom to name explicitly: if ANY terminal ever stops repainting until you drag
      it, click it, or resize something, that is a MISSED WAKE** — the failure this design fears,
      and far worse than the idle CPU it saves. Report it with what the terminal was doing when it
      froze and how long it stayed frozen (a heartbeat is supposed to heal it within ~1 second, so a
      freeze that lasts longer than that means the heartbeat is gone too).

## 5. Failure paths

> **READ THIS BEFORE 5.1–5.2b.** `WEBGL_lose_context.loseContext()` is a **synthetic** loss: the
> context stays lost until `restoreContext()` is called **on the same extension object**, and the
> app's `preventDefault()` does nothing for it (that only asks the browser to restore a loss the
> browser itself caused). So keep the extension in a variable and drive both halves by hand — a
> bare `loseContext()` tests item 5.2b, not 5.1.

- [ ] **5.1 Forced context loss — the canvas comes BACK.** In the DevTools console:
      ```js
      const x = document.querySelector('.glyphgrid-canvas')
        .getContext('webgl2').getExtension('WEBGL_lose_context')
      x.loseContext(); setTimeout(() => x.restoreContext(), 500)
      ```
      Expect: the canvas blanks for about half a second, then every terminal repaints on the SHARED
      renderer with its text intact and its cursor where it was — no reload, no re-registration, and
      terminals that were streaming keep streaming. The console carries exactly TWO glyphgrid lines,
      one naming the loss and one naming the restore; the Settings row still reads Shared and the
      mode is NOT failed. Note anything that comes back WRONG rather than blank (soft or garbled
      glyphs would mean the atlas page did not survive the GPU event, which the restore assumes it
      does — the fix is a forced repack, and `GlyphAtlas` already has the machinery for it). If the
      terminals do NOT come back on the shared renderer — blank bodies, or a permanent fallback to
      DOM after a loss the browser DID restore — that is a **BLOCKING** finding, for the same reason
      5.2b's hang is: a canvas that never returns from a restore is as unusable as one that never
      stops waiting.
      **Keep `x` — 5.2 needs the same object.**
- [ ] **5.2 A second loss inside a minute falls back permanently, as designed.** Within 60 s of 5.1
      (`RESTORE_COOLDOWN_MS` — the cooldown is armed by 5.1's SUCCESSFUL restore, so 5.1 must have
      passed first), on the same `x`: `x.loseContext()`. Expect: NO second restore attempt, ONE
      warning naming the repeat loss, and every terminal back on readable DOM text with nothing
      blank. The session stays failed until relaunch — that floor is deliberate, because handing a
      failing GPU its context back over and over is how one failure becomes a flicker. Switching to
      Auto and back still renders normally on Auto.
- [ ] **5.2b A loss that is never restored gives up on its own.** Reload the app (5.2 leaves the
      session failed), then force a loss and do NOT restore it: `document
      .querySelector('.glyphgrid-canvas').getContext('webgl2')
      .getExtension('WEBGL_lose_context').loseContext()`. Expect: the canvas blanks, and within ~5 s
      (`RESTORE_TIMEOUT_MS`) every terminal returns to readable DOM text with a second console line
      naming the give-up (`…lost and never restored`). The failure mode this guards is the canvas
      waiting FOREVER — transparent node bodies over a canvas that never paints again, with no
      second line on the console. If the terminals stay blank past ~10 s, that is a **BLOCKING**
      finding.
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
      avoids it). This run is what earned the promotion on 2026-08-05; any occurrence NOW is a
      **release blocker** — the macOS `'auto'` branch goes back to `'dom'`. Note the elapsed time,
      the terminal count, and whether the machine was on an external display, since the earlier
      reports had no console error to correlate against.

## 6. Regressions (the modes everyone else is on)

- [ ] **6.1 Auto.** Everything in §2/§3 that applies, on Auto. On macOS that is now the SHARED
      renderer, so §2/§3 apply verbatim; off macOS it is per-terminal WebGL and must be unchanged
      from `main`.
- [ ] **6.2 GPU per terminal.** Contexts are granted/reclaimed on pan and zoom exactly as before
      (zoom out past the suspend threshold → no contexts; zoom in → re-granted).
- [ ] **6.3 Off.** Every terminal on the DOM renderer, no WebGL contexts at all.
- [ ] **6.4 Settings round-trip.** Pick each of the four options, quit and relaunch: the choice is
      still there (`settings.json` holds `"terminalGpuRendering": "shared"` etc.).
- [ ] **6.5 Hand-edited garbage.** Set `"terminalGpuRendering": "warp-speed"` in `settings.json`
      and relaunch: the app comes up on **Auto**, i.e. on the platform default, not on some other
      mode the garbage happened to resemble.
- [ ] **6.6 Server Edition sanity.** (Optional, Linux/browser.) The Terminal rendering row exists
      and Auto/On/Off behave as before; Shared is expected to work but is not part of this gate.

---

## Known limitations (accepted — verify they are what you see, not that they are absent)

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
  The plate's square CORNERS were a separate question from its size — no rect size ever fixed them
  — and they are answered separately too: the plate is a rounded quad as of Phase 2, so the SHAPE
  is item **2.13** and the SIZE is this entry.
- **L6 — Adopting a parked terminal after a font change may keep a stale cell size.** The grid is
  registered from the cell xterm reports at adopt time; a font change applied in the same commit
  can land after it. Refreshing the node re-registers at the correct size.
- **L7 — Group-parented z: MODELLED in round 5, and no longer a limitation.** This used to read "an
  approximation": the order was array order plus selection, ignoring that React Flow gives a frame's
  child `parentZ >= childZ ? parentZ + 1 : childZ`. `nodeStackZ` now reproduces the rule for this
  app's configuration — no explicit `zIndex`, `elevateNodesOnSelect` on, and **`zIndexMode` at its
  default `'basic'`** (nothing in `src/` passes the prop) — and BOTH consumers read it, the grids' z
  and the opaque set, so they cannot disagree about who is on top. In `'basic'` the whole rule is:
  every node is `selected ? 1000 : 0`, and a child is one above its frame. So a group FRAME is z 0,
  **tied** with every ungrouped node — frames merely sort first in the array, which is why an
  ungrouped terminal overlapping a populated frame paints ON TOP of it — while that frame's children
  sit at 1, above both, and a selected frame carries its children to 1001. Nothing order-dependent
  is left in the model, so it is exact rather than approximate, and it is pinned by a differential
  test that runs the real `adoptUserNodes` over eleven canvas shapes. (The trap worth recording:
  `@xyflow/system` also has an `'auto'` branch that bands root frames by `ROOT_PARENT_Z_INCREMENT`,
  putting a populated frame at 10. Transcribing THAT branch is a way to conclude that a terminal
  lying on a frame is underneath it and leave it transparent — with the frame's dashed border and
  label pill showing through, the exact ghost round 5 removes.) Verify by item **3.10**.
- **L8 — The kanban card modal stays on xterm's DOM renderer, by design in v1.** The modal is a
  second, co-attached view of the same tmux session living outside the canvas' coordinate space;
  it has no grid, no camera and no z in the shared canvas. Board parity here is a Phase-2 question.
- **L14 — The atlas cell and the baseline latch to the FIRST terminal's usable measurement.** The
  atlas is rasterized into xterm's own `dimensions.device.cell`, handed over by whichever terminal
  builds the shared context first, and the baseline is derived from that same font at that moment.
  A **webfont that resolves later** therefore leaves the atlas on the fallback face's metrics for
  the life of the context — the text is measured and placed correctly, just against the wrong
  face's cell — until something disposes the context (a font-family/size change in Settings, or the
  dpr rebuild of item 4.15). A terminal whose device cell **diverges** from the atlas's for any
  other reason (a per-terminal letterSpacing) has its glyphs resampled against the quad they are
  drawn onto, i.e. slightly soft — never misplaced. Both are announced: `warnOnCellDrift` logs one
  `[glyphgrid] atlas cell … does not match …` line per context lifetime, so a soft terminal can be
  told apart from a soft display. Phase 2 (re-rasterize on `document.fonts.ready` / per-cell atlas
  pages).

  **Phase 1c narrows what is latched.** The FACE never was: `ctx.font` is set per draw, so any slot
  rasterized after a webfont resolves already uses the real face. What used to make that invisible is
  that a cached slot was cached forever — and the colour-keyed page now CLEARS AND REFILLS when it
  fills up (2.7c), which re-inks every slot with whatever face is resolved at that moment. So a late
  webfont propagates to already-cached glyphs on the next reset instead of never. What remains
  latched for the life of the context is the CELL and the BASELINE, both computed once at
  construction — i.e. the late-webfont symptom is now "right face, fallback face's metrics", and only
  a context rebuild fixes that.
- **L15 — A terminal that is STACKED OVER another node temporarily leaves the shared renderer.**
  (Rewritten in round 5. The round-4 entry — a hairline of the lower node's frame ghosting through
  the upper node's transparent body, plus "selection no longer raises a covered node" — described a
  trade that was **rejected** and no longer exists.)

  The structural fact: one canvas cannot interleave itself with per-node DOM stacking. A shared-mode
  terminal is a transparent WINDOW whose text lives on a canvas UNDER the whole node layer, so its
  only occluding surface is its grid's plate — also under every node's chrome. It can hide another
  node's canvas text (plate over plate) but never that node's border, header seam or label pill,
  which paint straight through. No z-ordering in either world fixes this.

  Round 4 tried to make the two orders agree by turning `elevateNodesOnSelect` off in shared mode.
  That worked and cost too much: dragging or selecting a node stopped bringing it to the front, and
  the frame hairline remained anyway. Round 5 replaces it with **"glyph in the open, DOM when
  stacked"**: a terminal renders through the shared canvas only while its body sits over empty
  canvas. The moment it could reveal a node beneath it, it hands the grid back and renders on
  xterm's own DOM renderer — opaque body, native stacking, total occlusion. The rule is
  `opaqueNodeIds` (`canvas/SharedGlyphLayer.tsx`): OPAQUE when the node's rect intersects the rect
  of any node BELOW it in the effective paint order, or while it (or a group frame containing it) is
  in a drag or resize gesture. A terminal that is only UNDERNEATH others stays on the canvas — the
  opaque node above hides it natively. Selection elevation is back on everywhere, and the frame
  ghost is gone with the transparency that caused it.

  **What remains, and what to watch for on device:** a stacked terminal is on the DOM renderer for
  as long as it is stacked, so its text is very slightly softer than its neighbours' at zoom ≠ 1
  (checklist 3.9b). The switch itself is the existing teardown/setup machinery that collapse and ⌘M
  already use, so it also costs one renderer swap per transition; the opaque set is frozen for the
  length of a gesture so a neighbour cannot be swapped twice a frame. Phase 2's answer if the DOM
  fallback turns out to be frequent enough to matter is a SECOND canvas above the node layer for an
  elevated tier — the two-tier design this envelope deliberately defers.

  **TWO THINGS THE RULE DOES NOT SEE — do not file either as a defect:**
  1. **Ephemeral subagent / loop cards.** They are merged into React Flow at the `<ReactFlow>` prop
     and are not in Canvas's `nodes` array (which is what keeps them out of persistence and undo),
     so the rule cannot see them. A card sitting over a glyph terminal can therefore be visible
     through that terminal's body. Display-only, and alive for the length of one turn.
  2. **A NEIGHBOUR's node-attached overhang.** The rule compares NODE RECTS, and two surfaces
     deliberately escape their node's rect: the 💬 comments flyout (`.term-node__comments`) and the
     kanban `ColumnPill`, both siblings of the overflow:hidden node root. Another node's flyout or
     pill overhanging a glyph terminal is outside every rect this rule compares, so it can show
     through. (The node's OWN flyout/pill is fine — selection elevation lifts them with it, which is
     what 3.9c tests.) Fixing this means feeding real chrome geometry into the rule — Phase 2, and
     the same question the "chrome on the canvas" answer settles for free.
- **L16 — A font-drawn SINGLE-WIDTH glyph whose INK EXCEEDS ITS CELL is clipped; the overflow is
  lost.** The rasterizer clips every `fillText` to the slot's own cell (`raster.ts` step 2), because
  a glyph that reached into the gutter would land in a neighbour's mip neighbourhood. xterm's own
  `TextureAtlas` has no such limit — it MEASURES each glyph's real bounding box, sizes the slot to
  the ink and renders a quad of that size, so ink may overhang into the neighbouring cells. That is
  why GPU mode can show shapes shared mode truncates.

  **DOUBLE-WIDTH characters left this limitation on 2026-08-05** (emoji, CJK). Their overflow was
  never really overflow: the terminal has already reserved a second cell for them, and the feed was
  writing it BLANK — so ⭐ arrived as a fragment (the 2026-08-05 device report). They need no
  ink-sized slot, only a second cell-sized one holding the character's right half: `glyphFor(…,
  half)` keys a second slot, `raster.ts` draws it with the glyph's origin one cell left, and the
  feed writes it into the follower's lane instead of a blank. Nothing this limitation defends moved
  — each half is still clipped to its own cell box, still 2*GUTTER_PX from its neighbour's ink, and
  the shader is untouched. Verify by item **2.16**. A glyph wider than TWO cells is still cut.

  The 2026-08-04 device round measured one instance: **U+23BF ⎿**, Claude Code's tool-result
  connector, kept about a third of its horizontal foot (8 px against GPU mode's 28). The **escape
  hatch used so far** is the geometric table — a glyph we DRAW is full-cell by construction, so the
  clip has nothing to cut — and that finding was fixed by adding four Misc-Technical aliases
  (`⎿ ⎾ ⎯ ⏐` → `└ ┌ ─ │`) to `box-glyphs.ts`. Line art is therefore covered; what remains is that an
  unusual FACE could clip something else that is not line art (an ornate script face, a symbol font
  with genuine side bearings), and no table entry helps there.

  Deliberately still on the font: `⎸ ⎹` (U+23B8/U+23B9, LEFT/RIGHT VERTICAL BOX LINE) sit flush on
  the cell EDGE rather than centred like `│`, so they are new geometry, not an alias.

  **Escalation if a non-line-art glyph ever needs the overflow:** do what xterm does — per-glyph
  bounding boxes, slots sized to the INK rather than to the cell, quads sized to the glyph. That
  touches the atlas allocator, the slot-rect derivation and the shader's uv maths at once, and it
  changes what the LOD/gutter argument defends. Phase 2.
- **L17 — A TOP-layer decoration renders as NOTHING.** xterm resolves decorations twice per cell,
  `bottom` before the selection and `top` after it; this engine resolves a cell once, with the
  selection last, so only `bottom` is expressible. Nothing in `src/` registers a decoration at all
  today, and `@xterm/addon-search` — the reason the module exists — registers its matches with no
  layer, which is `bottom` by xterm's own default, so it costs nothing to observe. **Trigger:** a
  top-layer decoration ever being shipped; `decorations.ts` (`decorationAt`) is where the second
  override stage goes.

---

## Result

Record one block per run, newest last.

### 2026-08-05 — the promotion gate

- Date / machine / OS / display setup: 2026-08-05, author's Mac, built-in **and** external display
- Blocking findings: none — no whole-window flicker, no black-composited node over the §5.6 soak
  (≥30 minutes, a dozen busy terminals)
- Non-blocking findings (with the item number): (fill in from the run's notes)
- Verdict: **promote** — `auto` resolves to the shared renderer on macOS

### Template

- Date / machine / OS / display setup:
- Blocking findings:
- Non-blocking findings (with the item number):
- Verdict: keep the macOS default / revert it to the DOM renderer
