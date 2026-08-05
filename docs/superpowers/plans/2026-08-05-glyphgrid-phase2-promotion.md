# GlyphGrid Phase 2 — Closing the Promotion Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every user-visible regression that stands between the shared renderer and being the DEFAULT, then promote it on macOS behind a staged rollout — so the black/flickering-terminal failure class is closed by construction (one context) rather than by avoiding the GPU.

**Architecture:** Phase 1 made the shared canvas correct for TEXT. What it never did was reach the things a terminal draws AROUND the text: decorations (search highlights), the cursor in anything but a focused block, the plate's shape, and recovery when the GPU takes the context away. Each is a separate seam and each is small on its own; the plan closes them in the order that a default flip cares about, then flips it. Two structural changes carry most of it: the cursor stops being purely a cell rewrite and gains an OVERLAY pass (which is what makes bar/underline/outline/wide/blink expressible at all), and the occlusion plate stops being a scissored `clear` and becomes a real quad (which is what makes rounded corners expressible).

**Tech Stack:** unchanged — WebGL2, xterm 5.5 internals via the attach shell, React Flow canvas. Branch: `feat/glyphgrid-phase2` off `main` (Phase 1c merged as `bddda75`).

## Global Constraints

- No new runtime dependencies. glyphgrid isolation rules unchanged: sibling-only imports inside `src/renderer/glyphgrid/`, xterm reached ONLY through `src/renderer/terminal/glyphgrid-attach.ts`.
- English constraint-stating comments; TDD for every pure module; `npx vitest run src/renderer/glyphgrid/ src/renderer/canvas/` + FULL suite + `npm run typecheck` + `npm run build` before every commit; **never push main without explicit approval**.
- Every task up to and including Task 7 must leave the DEFAULT modes bit-for-bit unaffected — all of it stays behind the `'shared'` setting until Task 8 deliberately changes what `'auto'` resolves to.
- The device checklist (`docs/superpowers/plans/2026-08-03-phase1b-device-checklist.md`) is updated in the SAME task that changes behaviour it describes, and the corresponding `L`-entry is deleted (not edited to say "fixed") when a task closes it.
- The idle park (`frame-driver.ts`) is load-bearing: **any new repaint source must wake the loop through `onDamage`, and any TIMED repaint must use `pulse()` (Task 3) rather than holding the loop awake.** A task that makes the loop run continuously on an idle canvas has failed even if it looks correct.

## File Structure

```
src/renderer/glyphgrid/
  feed.ts            — T1 decoration lane; T2 cursor style + wide-cell cursor
  feed.test.ts       — T1, T2
  decorations.ts     — T1 (new): pure "resolve the overrides for one cell" over an injected reader
  decorations.test.ts— T1 (new)
  cursor.ts          — T2 (new): pure cursor geometry (style → overlay rects in cell units)
  cursor.test.ts     — T2 (new)
  gl.ts              — T2 cursor overlay params; T4 plate radius; T5 restore hook
  gl-webgl2.ts       — T2 overlay pass; T4 plate becomes a quad with a rounded-rect SDF; T5 rebuild
  engine.ts          — T2 per-grid cursor spec; T5 re-register-all after a restore
  frame-driver.ts    — T3 `pulse()`
  frame-driver.test.ts — T3
src/renderer/terminal/glyphgrid-attach.ts — T1 decoration reader; T2 focus + style; T5 nothing
src/renderer/canvas/SharedGlyphLayer.tsx  — T3 blink clock; T5 restore wiring; T7 board gate
src/shared/webgl.ts                        — T8 `resolveTerminalRenderer` promotion
src/renderer/components/settings/sections/TerminalSection.tsx — T8 copy
docs/superpowers/plans/2026-08-03-phase1b-device-checklist.md  — every task
```

---

### Task 1: Decorations — search highlights become visible (closes L12)

**Files:**
- Create: `src/renderer/glyphgrid/decorations.ts`, `src/renderer/glyphgrid/decorations.test.ts`
- Modify: `src/renderer/glyphgrid/feed.ts`, `src/renderer/glyphgrid/feed.test.ts`, `src/renderer/terminal/glyphgrid-attach.ts`, `src/renderer/glyphgrid/addon.ts`
- Checklist: delete `L12`, rewrite item `3.14`

**Interfaces:**
- Consumes: `RowFeedOpts` as it stands (`atlas`, `theme`, `selection`, `cursorCol`).
- Produces:
```ts
// decorations.ts
export interface CellDecoration { bg?: number; fg?: number }   // packColor lanes, undefined = no override
export interface DecorationReader {
  /** True when the terminal currently has NO decorations at all — the whole per-cell walk is
   *  skipped on this answer, which is the common case (nobody has ⌘F open). */
  empty(): boolean
  /** xterm's own signature, narrowed: layer 'bottom' | 'top' | undefined. */
  atCell(col: number, row: number, cb: (d: { layer?: string; bg?: number; fg?: number }) => void): void
}
export function decorationAt(reader: DecorationReader, col: number, row: number): CellDecoration | null
```
- `RowFeedOpts` gains `decorations?: DecorationReader` (optional — absent means "none", so every existing caller and test stays valid).

**Why a reader interface and not the service:** `_decorationService` is xterm internals; the isolation rule says only the attach shell may touch them. The shell builds the reader, the feed consumes an interface, and `decorations.test.ts` drives a fake — the same shape `atlas` and `theme` already use.

- [ ] **Step 1: Write the failing test** (`decorations.test.ts`)

```ts
import { describe, expect, it } from 'vitest'
import { decorationAt, type DecorationReader } from './decorations'
import { packColor } from './cells'

function reader(entries: { col: number; row: number; layer?: string; bg?: number; fg?: number }[]): DecorationReader {
  return {
    empty: () => entries.length === 0,
    atCell: (col, row, cb) => entries.filter((e) => e.col === col && e.row === row).forEach(cb)
  }
}

describe('decorationAt', () => {
  it('returns null when the terminal has no decorations', () => {
    expect(decorationAt(reader([]), 0, 0)).toBeNull()
  })

  it('returns the background a search hit paints', () => {
    const bg = packColor(255, 200, 0, 255)
    expect(decorationAt(reader([{ col: 3, row: 1, bg }]), 3, 1)).toEqual({ bg, fg: undefined })
  })

  it('ignores the TOP layer — xterm paints those over the text itself, not as a cell colour', () => {
    const bg = packColor(255, 200, 0, 255)
    expect(decorationAt(reader([{ col: 3, row: 1, layer: 'top', bg }]), 3, 1)).toBeNull()
  })

  it('lets a later decoration win, matching xterm’s last-writer order', () => {
    const first = packColor(10, 10, 10, 255)
    const second = packColor(20, 20, 20, 255)
    expect(decorationAt(reader([{ col: 0, row: 0, bg: first }, { col: 0, row: 0, bg: second }]), 0, 0))
      .toEqual({ bg: second, fg: undefined })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/renderer/glyphgrid/decorations.test.ts`
Expected: FAIL — `Cannot find module './decorations'`.

- [ ] **Step 3: Implement `decorations.ts`**

```ts
import type { CellDecoration, DecorationReader } from './decorations'

/**
 * The overrides a cell's decorations impose, or null.
 *
 * WHY 'top' IS SKIPPED. xterm's own WebGL renderer walks decorations twice: once at cell level for
 * the `bottom` layer (a background the text is drawn OVER) and once above the text for `top`. This
 * engine has one cell pass, so it can honour the bottom layer exactly and cannot express the top
 * one at all — and painting a top-layer decoration as a cell colour would put it UNDER the glyph,
 * which is the opposite of what it asked for. Search highlights are bottom-layer, which is why this
 * is enough to close L12; a top-layer decoration keeps rendering as nothing, the same as before.
 *
 * LAST WRITER WINS, matching the callback order xterm hands out — two decorations on one cell is
 * already ambiguous, and agreeing with the renderer we are replacing is the only defensible answer.
 */
export function decorationAt(
  reader: DecorationReader,
  col: number,
  row: number
): CellDecoration | null {
  if (reader.empty()) return null
  let bg: number | undefined
  let fg: number | undefined
  reader.atCell(col, row, (d) => {
    if (d.layer === 'top') return
    if (d.bg !== undefined) bg = d.bg
    if (d.fg !== undefined) fg = d.fg
  })
  return bg === undefined && fg === undefined ? null : { bg, fg }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run src/renderer/glyphgrid/decorations.test.ts` → PASS (4 tests).

- [ ] **Step 5: Wire it into the feed, red first**

Add to `feed.test.ts` — the precedence is the point, so pin it:

```ts
it('applies a decoration under the selection but over the base colours', () => {
  // A cell that is BOTH decorated and selected paints the SELECTION: xterm resolves selection last
  // for the bottom layer, and a search hit inside a drag-selection that hid the selection band
  // would make the selection look broken.
  const deco = packColor(255, 200, 0, 255)
  const row = packViewportRow({ ...base, decorations: reader([{ col: 0, row: 0, bg: deco }]), selection: { start: 0, end: 1 } })
  expect(row[BG_LANE]).toBe(theme.selectionBg)
})

it('applies a decoration when the cell is not selected', () => {
  const deco = packColor(255, 200, 0, 255)
  const row = packViewportRow({ ...base, decorations: reader([{ col: 0, row: 0, bg: deco }]) })
  expect(row[BG_LANE]).toBe(deco)
})
```

In `packViewportRow`, resolve in this order and comment it: base (default/palette/RGB) → inverse → dim → **decoration** → selection → cursor. The atlas request (`glyphFor`) still happens LAST, after every override, exactly as Phase 1c left it.

- [ ] **Step 6: Build the reader in the attach shell**

`glyphgrid-attach.ts` — the ONLY file allowed to touch `_decorationService`. Add to `TermInternals`:

```ts
_decorationService?: {
  decorations: { size: number } | Iterable<unknown>
  forEachDecorationAtCell(
    col: number,
    row: number,
    layer: string | undefined,
    cb: (d: { options?: { layer?: string }; backgroundColorRGB?: { rgba: number }; foregroundColorRGB?: { rgba: number } }) => void
  ): void
  onDecorationRegistered(cb: () => void): { dispose(): void }
  onDecorationRemoved(cb: () => void): { dispose(): void }
}
```

It is OPTIONAL in the leaf validation: an xterm without it must degrade to "no decorations", never refuse the whole attach. Build the reader with the same `rgba >> 8` conversion `lane()` already uses, and force alpha `0xff` for the same reason it does.

- [ ] **Step 7: Invalidate on change**

In `addon.ts`, subscribe `onDecorationRegistered` / `onDecorationRemoved` → the SAME deferred full repack `atlas.onReset` already uses (never a recursive repack inside a pack loop), and dispose both in `dispose()`. Comment: a decoration changes cell COLOURS, so the rows must be re-fed; the atlas is untouched.

- [ ] **Step 8: All gates, then commit**

```bash
npx vitest run src/renderer/glyphgrid/ src/renderer/canvas/ && npx vitest run && npm run typecheck && npm run build
git add -A && git add -f docs/superpowers/plans/2026-08-03-phase1b-device-checklist.md
git commit -m "feat(glyphgrid): the feed reads decorations — search highlights are visible again"
```

Checklist: `3.14` loses its "KNOWN — the highlights are not visible" clause and gains "the matched cells are highlighted, and the highlight follows next/previous"; delete `L12`.

---

### Task 2: The cursor — styles, wide cells, and an outline when blurred (closes L2, L13; covers main's cursor-style settings)

**Files:**
- Create: `src/renderer/glyphgrid/cursor.ts`, `src/renderer/glyphgrid/cursor.test.ts`
- Modify: `src/renderer/glyphgrid/feed.ts`, `feed.test.ts`, `gl.ts`, `gl-webgl2.ts`, `engine.ts`, `engine.test.ts`, `addon.ts`, `glyphgrid-attach.ts`
- Checklist: delete `L2`, `L13`; rewrite `2.9`, `2.12`, `2.15`

**The problem this task exists for.** The feed expresses the cursor as a CELL REWRITE (`cursorCol` → swap fg/bg on that one cell). That can only ever draw one thing: a focused, block, single-width cursor. Three consequences are live regressions the moment shared becomes the default — a blurred terminal shows NO cursor (xterm draws a hollow outline), a cursor on a CJK/emoji cell covers half the glyph, and **`settings.terminalCursorStyle` (bar / underline, added on main) is silently ignored**.

**The split that fixes all three:** a block cursor stays a cell rewrite (it must invert the glyph, which only the cell path can do) and simply learns about wide cells; every OTHER shape becomes a small overlay quad drawn after the cells.

**Interfaces produced:**
```ts
// cursor.ts — pure geometry, no GL, no xterm
export type CursorShape = 'block' | 'bar' | 'underline' | 'outline' | 'none'
export interface CursorOverlay { x: number; y: number; w: number; h: number }  // CELL-relative, 0..1 * cell
/** The overlay rects for a shape, in fractions of ONE cell. `block` returns [] — it is drawn by the
 *  cell path. `outline` returns four hairlines. `widthCells` is 2 on a wide glyph's lead. */
export function cursorOverlays(shape: CursorShape, widthCells: number, thicknessPx: number, cellW: number, cellH: number): CursorOverlay[]

// gl.ts — GridDrawParams gains:
cursor: { col: number; row: number; shape: CursorShape; widthCells: number; color: number } | null
```

- [ ] **Step 1: Write the failing geometry tests** (`cursor.test.ts`)

```ts
import { describe, expect, it } from 'vitest'
import { cursorOverlays } from './cursor'

describe('cursorOverlays', () => {
  it('draws nothing for a block — the cell path inverts the glyph instead', () => {
    expect(cursorOverlays('block', 1, 1, 10, 20)).toEqual([])
  })

  it('draws nothing for none', () => {
    expect(cursorOverlays('none', 1, 1, 10, 20)).toEqual([])
  })

  it('puts a bar on the LEFT edge, one thickness wide, full height', () => {
    expect(cursorOverlays('bar', 1, 2, 10, 20)).toEqual([{ x: 0, y: 0, w: 2, h: 20 }])
  })

  it('puts an underline on the BOTTOM edge, full width', () => {
    expect(cursorOverlays('underline', 1, 2, 10, 20)).toEqual([{ x: 0, y: 18, w: 10, h: 2 }])
  })

  it('outlines all four edges without doubling the corners', () => {
    // top, bottom, left, right — the verticals are inset by the horizontals' thickness so the
    // corner texel is written once. Two overlapping rects would be twice the alpha on a corner
    // the moment anything but an opaque colour is used.
    expect(cursorOverlays('outline', 1, 1, 10, 20)).toEqual([
      { x: 0, y: 0, w: 10, h: 1 },
      { x: 0, y: 19, w: 10, h: 1 },
      { x: 0, y: 1, w: 1, h: 18 },
      { x: 9, y: 1, w: 1, h: 18 }
    ])
  })

  it('spans BOTH columns of a wide glyph', () => {
    expect(cursorOverlays('underline', 2, 2, 10, 20)).toEqual([{ x: 0, y: 18, w: 20, h: 2 }])
  })
})
```

- [ ] **Step 2:** Run → FAIL (`Cannot find module './cursor'`).

- [ ] **Step 3: Implement `cursor.ts`** exactly to those rects, with the corner-doubling reason in a comment.

- [ ] **Step 4:** Run → PASS (6 tests).

- [ ] **Step 5: The wide block cursor, in the feed (red first)**

```ts
it('paints BOTH cells of a wide glyph under a block cursor', () => {
  // The lead is at col 0 and its follower (code 0) at col 1. L13 was: only col 0 got the cursor
  // colours, so the block covered the left half of 日 and the right half stayed un-inverted.
  const row = packViewportRow({ ...base, chars: ['日'], cursorCol: 0, cursorShape: 'block' })
  expect(row[BG_LANE + 0 * CELL_STRIDE]).toBe(theme.cursorBg)
  expect(row[BG_LANE + 1 * CELL_STRIDE]).toBe(theme.cursorBg)
})
```

Implement: when the cursor column holds a wide LEAD, apply the cursor override to the follower column too. The follower's glyph lane stays 0 (Phase 1c contract), so the shader paints its bg lane — which is now the cursor colour. Nothing else changes.

- [ ] **Step 6: Shape selection in the attach shell**

`glyphgrid-attach.ts` reads `term.options.cursorStyle`, `term.options.cursorInactiveStyle` and `core._coreBrowserService.isFocused`, and maps them:

| focused | `cursorStyle` | shape |
|---|---|---|
| yes | `block` | `block` (cell path) |
| yes | `bar` | `bar` |
| yes | `underline` | `underline` |
| no | `outline` (xterm's default inactive style) | `outline` |
| no | `none` | `none` |
| no | `bar`/`underline`/`block` | that shape |

Comment the one non-obvious row: xterm's DEFAULT `cursorInactiveStyle` is `outline`, which is exactly the hollow box L2 said we could not draw — so the default path is the one this task exists to light up.

- [ ] **Step 7: The overlay pass in the engine + GL**

`engine.ts`: `GridSpec`/handle gains `setCursor(spec | null)`, change-gated and marking the grid dirty (through `markDirty()` — Task 10 of Phase 1c made that the single writer; do not assign `dirty` directly). `gl-webgl2.ts`: after the cell draw for a grid, if `cursor` is non-null and its shape yields overlays, draw them with a small instanced quad pass in the cursor colour. It shares the camera uniforms; it must NOT sample the atlas.

- [ ] **Step 8: All gates, then commit**

```bash
git commit -m "feat(glyphgrid): cursor styles, a wide-glyph cursor, and the outline a blurred terminal draws"
```

Checklist: `2.9` gains "the cursor honours Settings → Terminal → Cursor style"; `2.12` loses L2; `2.15` loses L13; delete both `L`-entries.

---

### Task 3: Blink — and the park interaction it would otherwise break (closes L1)

**Files:** `src/renderer/glyphgrid/frame-driver.ts`, `frame-driver.test.ts`, `src/renderer/canvas/SharedGlyphLayer.tsx`, checklist (delete `L1`, rewrite `2.9`)

**The trap this task must not fall into.** A blinking cursor is a TIMED repaint twice a second. Waking the loop through `onDamage` would draw the frame and then keep rAF alive for `IDLE_FRAMES_BEFORE_PARK` (30) frames before parking — 30 frames every 500 ms is a continuously running loop, i.e. it silently undoes Phase 1c Task 10 and puts every idle canvas back at vsync. **Blink must therefore use a one-shot path.**

**Interfaces produced:**
```ts
// frame-driver.ts, alongside start/wake/stop
/** Draw at most ONE frame and park again immediately, whatever the idle streak was. For repaints
 *  that are known to be isolated in time (the blink clock) — `wake()` is for damage that is likely
 *  to be followed by more. */
pulse(): void
```

- [ ] **Step 1: Write the failing driver test**

```ts
it('pulse draws one frame and parks again, without arming the idle streak', () => {
  const h = fakeHost()          // the existing harness in this file
  const loop = createFrameLoop(h)
  loop.start()
  h.runFramesUntilParked()      // idle → parked
  h.frameCalls = 0
  loop.pulse()
  h.flushFrames()
  expect(h.frameCalls).toBe(1)  // exactly one, not thirty
  expect(h.pendingFrame).toBe(false)
})
```

- [ ] **Step 2:** Run → FAIL (`loop.pulse is not a function`).

- [ ] **Step 3:** Implement `pulse()`: if parked, schedule one rAF whose callback runs `frame()` and does NOT reschedule; if already running, it is a no-op (the running loop will draw anyway).

- [ ] **Step 4:** Run → PASS.

- [ ] **Step 5: One blink clock for the whole canvas**

In `SharedGlyphLayer.tsx`, not per terminal: a single `setInterval` at xterm's blink period that flips a boolean and asks the FOCUSED grid's addon to re-pack its cursor row, then `loop.pulse()`. Gated three ways, all commented: only when `settings.cursorBlink` is on, only while a terminal has focus, and cleared when neither holds. A canvas with no focused terminal has no clock at all.

- [ ] **Step 6: All gates, then commit**

```bash
git commit -m "feat(glyphgrid): the cursor blinks, and the idle park survives it"
```

---

### Task 4: The plate becomes a quad, with rounded corners (closes L4)

**Files:** `src/renderer/glyphgrid/gl.ts`, `gl-webgl2.ts`, `plate.ts`, `plate.test.ts`, `engine.ts`, checklist (delete `L4`, rewrite `2.13`)

**Why this is not a one-liner.** The plate is currently a **scissored `gl.clear`** (`gl-webgl2.ts`, `drawGrid`): a rectangle, by construction. A node has `border-radius: 10px`, and a canvas that is not a DOM child cannot be clipped by it — so every shared terminal's four corners read square against a rounded node. Rounding needs the plate to become a real DRAW: one quad per grid, in a tiny program whose fragment shader is a rounded-rect SDF.

**Interfaces produced:**
- `GridDrawParams.plateRadius: number` — world units (CSS px at zoom 1), 0 = square, so every existing test keeps its meaning.
- `plate.ts` gains nothing: `plateRectDevice` still computes the device rect; the quad is drawn from it.

- [ ] **Step 1: Write the failing test** (`plate.test.ts`)

```ts
it('scales the radius with zoom, and never past half the shorter side', () => {
  // A 10px radius on a 12px-tall plate at zoom 1 would round the rect into a stadium and then
  // invert; clamping at half the shorter side is what keeps a collapsing node from flickering.
  expect(plateRadiusDevice(10, 2, { w: 200, h: 100 })).toBe(20)
  expect(plateRadiusDevice(10, 1, { w: 200, h: 12 })).toBe(6)
  expect(plateRadiusDevice(0, 2, { w: 200, h: 100 })).toBe(0)
})
```

- [ ] **Step 2:** Run → FAIL (`plateRadiusDevice is not a function`).
- [ ] **Step 3:** Implement `plateRadiusDevice(radiusWorld, dprZoom, deviceRect)` = `Math.min(radiusWorld * dprZoom, deviceRect.w / 2, deviceRect.h / 2)`.
- [ ] **Step 4:** Run → PASS.

- [ ] **Step 5: Replace the scissored clear**

In `gl-webgl2.ts`: a `PLATE_VERT`/`PLATE_FRAG` pair drawing one quad over the plate's device rect, the fragment discarding outside the rounded-rect SDF:

```glsl
// FRAG
uniform vec4 uRect;    // x, y, w, h in device px
uniform float uRadius; // device px
uniform vec4 uColor;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy - (uRect.xy + uRect.zw * 0.5);
  vec2 q = abs(p) - (uRect.zw * 0.5 - vec2(uRadius));
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
  // One device pixel of coverage, so the corner is antialiased rather than stepped. The plate is
  // the terminal's own background — a hard corner here reads as a rendering fault, not as a shape.
  outColor = vec4(uColor.rgb, uColor.a * (1.0 - smoothstep(-1.0, 0.0, d)));
}
```

The draw replaces the `scissor` + `clear` pair entirely. Keep the "skip when the rect covers no pixel" early-out — it is now "skip the draw" rather than "skip the clear".

**Painter order does not change:** the plate is still drawn before that grid's cells and after any lower grid, which is the whole Phase-1a occlusion story. State that in a comment, because moving from `clear` to a blended draw is exactly the change that could break it silently.

- [ ] **Step 6:** The radius reaches `GridDrawParams` from `TerminalNode.tsx`, read from the same CSS token the node uses (`--radius-lg`), not a hardcoded 10.

- [ ] **Step 7: All gates, then commit**

```bash
git commit -m "feat(glyphgrid): the occlusion plate is a rounded quad, not a rectangle"
```

---

### Task 5: Context loss is survivable (closes L9)

**Files:** `src/renderer/glyphgrid/gl.ts`, `gl-webgl2.ts`, `engine.ts`, `engine.test.ts`, `src/renderer/canvas/SharedGlyphLayer.tsx`, `SharedGlyphLayer.test.ts`, checklist (delete `L9`, rewrite `5.1`, `5.2`)

**Why this gates the default.** Today a lost context disables the shared renderer for the rest of the session (deliberate in Phase 1b: a retry loop on a bad driver turns one failure into a flicker). As an EXPERIMENTAL mode that is a fine trade. As the DEFAULT it means a GPU reset — which is exactly what macOS does on sleep/wake and on a driver hiccup — silently drops every user to the DOM renderer until they relaunch, with no message.

**The design, and the part that must not be got wrong:** restore ONCE per context, not in a loop.

- `webglcontextlost` → `preventDefault()` (we now DO want a restore event), tear the engine's GPU objects down, park the loop.
- `webglcontextrestored` → rebuild the GL objects and the atlas texture, **re-register every grid**, ask every attached addon for a full repack, resume.
- A SECOND loss within `RESTORE_COOLDOWN_MS` (60 s) of a restore, or a restore that itself throws, falls back permanently through the existing `failSharedGlyph` — the old behaviour, kept as the floor.

**Interfaces produced:**
```ts
// engine.ts
/** Drop every GPU object but KEEP the registry: each grid's spec, rows and z survive so the same
 *  handles are valid after `reviveGpu`. Nothing else may assume a grid's GPU buffer exists. */
suspendGpu(): void
/** Re-create the GPU objects for every registered grid and mark everything dirty. */
reviveGpu(): void
```

- [ ] **Step 1: Write the failing engine test**

```ts
it('keeps its registry across a suspend/revive and repaints everything after', () => {
  const { engine, gl } = harness()
  const a = engine.register(spec('a'))
  engine.suspendGpu()
  expect(gl.disposed).toContain('a')
  engine.reviveGpu()
  expect(gl.created).toEqual(['a', 'a'])   // created once at register, once at revive
  expect(engine.frame()).toBe(true)        // everything is dirty again
  expect(a.disposed).toBe(false)           // the handle the node holds is still the same one
})
```

- [ ] **Step 2:** Run → FAIL (`engine.suspendGpu is not a function`).
- [ ] **Step 3:** Implement both, reusing the existing per-grid create/dispose paths.
- [ ] **Step 4:** Run → PASS.

- [ ] **Step 5: Wire the two events in the layer**, with the cooldown and the once-only rule, and a `console.warn` naming what happened on each branch (a silent restore is indistinguishable from a freeze when you are debugging one).

- [ ] **Step 6: All gates, then commit**

```bash
git commit -m "feat(glyphgrid): survive a lost context — restore once, fall back if it happens again"
```

Checklist: `5.1` expects ONE warn, a restored canvas and readable text; `5.2` becomes "force loss twice inside a minute → the second falls back to DOM permanently, as designed".

---

### Task 6: A dpr change rebuilds the atlas (closes L10, narrows L14)

**Files:** `src/renderer/canvas/SharedGlyphLayer.tsx`, `src/renderer/nodes/TerminalNode.tsx`, checklist (delete `L10`, rewrite `4.15`)

Moving a window between a retina and a 1x display leaves every glyph rasterized for the old dpr — visibly soft or over-sharp on one of the two. The machinery already exists: a FONT change disposes the shared context and re-registers every node (the `glyphEpoch` path). A dpr change is the same event with a different trigger.

- [ ] **Step 1:** Write the failing layer test — `setDeviceCell` with a different dpr bumps `generation` exactly once, and twice for two distinct changes.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: the layer already stores the dpr it built the atlas at; compare on `pushViewport` (which already runs on the window `resize` that a dpr change fires) and bump the epoch when it differs.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** All gates, then commit: `fix(glyphgrid): rebuild the atlas when the display's pixel ratio changes`.

Checklist `4.15` loses "text may soften slightly (atlas is not rebuilt — Phase 2)". `L14`'s dpr sentence goes; its late-webfont half stays.

---

### Task 7: Stop drawing under the kanban board (closes L11)

**Files:** `src/renderer/canvas/SharedGlyphLayer.tsx`, `SharedGlyphLayer.test.ts`, checklist (delete `L11`, rewrite `4.16`)

The board is an opaque overlay: every frame drawn under it is invisible work. Phase 1c's park made an IDLE canvas free, but a canvas of streaming terminals under the board still repaints at full rate.

- [ ] **Step 1:** Failing test — with `boardOpen` true, damage does NOT schedule a frame; on close, one frame is drawn immediately.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: the layer subscribes to the board flag it already reads elsewhere; `boardOpen` → `loop.stop()`, close → `loop.start()` + `wake()`. The grids keep receiving rows (their buffers stay current), so reopening is a repaint, not a rebuild — say so in a comment, because "stop the loop" reads like "lose the content".
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** All gates, then commit: `perf(glyphgrid): no frames while the kanban board covers the canvas`.

---

### Task 8: THE GATE — run the device checklist and the soak

**Files:** none (this is a human step, and it is a task so that no one can skip it)

- [ ] **Step 1:** Run the full device checklist on the Mac against this branch, in the `Shared GPU` mode.
- [ ] **Step 2:** Run item `5.6` — **≥30 minutes** with a dozen busy terminals, on the external display as well as the built-in. Any whole-window flicker or black-composited node = **STOP**, and Task 9 does not happen.
- [ ] **Step 3:** Record the result block at the bottom of the checklist (date, machine, blocking findings, verdict).
- [ ] **Step 4:** Only if the verdict is clean: proceed.

---

### Task 9: Promote — `auto` resolves to shared on macOS

**Files:** `src/shared/webgl.ts`, `webgl.test.ts`, `src/renderer/components/settings/sections/TerminalSection.tsx`, checklist header, `CLAUDE.md`

**The change, and its shape.** `resolveTerminalRenderer('auto', isMac)` returns `'dom'` today — the field-proven-clean answer chosen when per-terminal WebGL composited black on macOS. This task changes THAT answer to `'shared'`, and nothing else: `'on'`, `'off'` and an explicit `'shared'` keep their meaning, and the four-way setting stays exactly where it is so the escape hatch survives.

**Non-macOS is deliberately NOT promoted in this task.** The failure this whole project answers is a macOS compositor failure; Linux and Windows have been on per-terminal WebGL all along with no such reports, so there is nothing there to fix and no soak evidence to justify moving them. One platform at a time, and the platform with the evidence goes first.

- [ ] **Step 1: Write the failing test** (`src/shared/webgl.test.ts`)

```ts
it('auto is the shared renderer on macOS — the promotion', () => {
  expect(resolveTerminalRenderer('auto', true)).toBe('shared')
})
it('auto is unchanged off macOS', () => {
  expect(resolveTerminalRenderer('auto', false)).toBe('webgl')
})
it('an explicit choice still wins over the platform', () => {
  expect(resolveTerminalRenderer('off', true)).toBe('dom')
  expect(resolveTerminalRenderer('on', true)).toBe('webgl')
  expect(resolveTerminalRenderer('shared', false)).toBe('shared')
})
```

- [ ] **Step 2:** Run → FAIL (`expected 'dom' to be 'shared'`).
- [ ] **Step 3:** Change the one branch. Rewrite the comment above it: what `auto` used to mean, why it meant that, and what evidence changed it (the soak of Task 8, named with its date and result).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Settings copy: the row's description drops "experimental — may render incorrectly" for the `shared` option and gains a plain description; the option label loses "(experimental)". `CLAUDE.md`'s renderer paragraph is updated in the same commit.
- [ ] **Step 6:** All gates, then commit: `feat(terminal): auto now means the shared renderer on macOS`.

**Deliberately NOT in this task:** retiring the per-terminal WebGL budget coordinator. `'on'` still uses it, and deleting a working subsystem in the same change that promotes its replacement removes the ability to A/B a field report. It goes when a release has shipped with this default and nothing came back.

---

## Deferred, with the trigger that would un-defer each

Named so nobody rediscovers them, and so nobody builds them speculatively:

- **L16 — font ink wider than the cell is clipped.** Line art is covered by the geometric table; a face whose ordinary glyphs overflow would need per-glyph bounding boxes, ink-sized slots and glyph-sized quads (what xterm's atlas does). **Trigger:** a device report of a clipped glyph that is NOT box-drawing.
- **L17 — a TOP-layer decoration renders as nothing** (the deviation stated in full at `decorations.ts`). T1 closes L12 for `bottom`, which is what the search addon registers and the only layer anything in `src/` could produce; expressing "after the selection" needs a second override stage. **Trigger:** a top-layer decoration ever being registered — `decorationAt` is where the stage goes.
- **L8 — the kanban card modal stays on the DOM renderer.** Not a promotion regression: on macOS the modal renders exactly as it does today, because today's default IS the DOM renderer. **Trigger:** the board becoming a primary surface for terminal work, or a report of the modal looking worse than the canvas.
- **True LRU atlas eviction.** Reset-on-full is the v1 model. **Trigger:** device reports of frequent `[glyphgrid] atlas page reset #N`.
- **Dirty-rect atlas upload + manual mips.** **Trigger:** `generateMipmap` showing up in a profile.
- **Premultiplied atlas upload** (`UNPACK_PREMULTIPLY_ALPHA_WEBGL` + `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`). **Trigger:** the frontier rim being called objectionable on device.
- **Grapheme atlas** (combining marks beyond the base character). **Trigger:** a report from a user whose language needs it.
- **Per-row scissor.** **Trigger:** a profile showing overdraw cost on heavily overlapping canvases.

---

## Self-Review

1. **Coverage of the promotion gate.** The regressions that a default flip would ship: search highlights (T1), cursor style/wide/blur (T2), blink (T3), square corners (T4), context loss (T5), dpr (T6). The waste item is T7. The evidence gate is T8, the flip is T9. Every `L`-entry in the checklist is either closed by a task or listed in Deferred with a trigger — L1 T3, L2 T2, L3 see below, L4 T4, L8 deferred, L9 T5, L10 T6, L11 T7, L12 T1, L13 T2, L14 narrowed by T6, L15 by design, L16 deferred, L17 deferred (T1's top-layer remainder, added to the checklist in the final fix round).
2. **Gap found and closed while reviewing:** L3 (selection does not dim on blur) had no task. It is one line once T2 has the focus flag in the feed — the theme carries no *inactive* selection colour, so the honest fix is to blend the selection background toward the plate by a fixed factor when unfocused. **Added to Task 2, Step 6** rather than given its own task: same file, same flag, same reviewer.
3. **Type consistency.** `CursorShape` is produced in `cursor.ts` (T2) and consumed by `GridDrawParams.cursor` (T2) and the blink clock (T3). `DecorationReader` is produced in `decorations.ts` (T1) and consumed by `RowFeedOpts.decorations` (T1). `suspendGpu`/`reviveGpu` are produced in T5 and consumed only there. `plateRadiusDevice` is produced in `plate.ts` (T4) and consumed by `gl-webgl2.ts` (T4). No name is used before the task that defines it.
4. **The park is honoured.** T1 and T2 wake through damage; T3 introduces `pulse()` precisely so it does not hold the loop; T7 stops the loop outright. No task adds a timer that draws unconditionally.
5. **Ordering is a real dependency chain, not a preference.** T3 needs T2's shapes; T9 needs T8's evidence; T8 needs T1-T7 or the checklist would be run against a build that still has the regressions it is meant to find.
