/** COLOR glyph atlas BOOKKEEPING. Rasterization is injected (GlyphRasterizer) so this module is
 *  pure and unit-testable; the real rasterizer (raster.ts) paints each slot's real background and
 *  then the glyph in its real foreground onto an OffscreenCanvas that gl-webgl2.ts uploads as the
 *  atlas texture.
 *
 *  WHY COLORED, not monochrome-plus-a-tint. The old atlas stored white-on-black COVERAGE keyed
 *  `code|bold italic` and the fragment shader mixed fg/bg by it — one slot per glyph shape, at the
 *  cost of performing the anti-aliasing blend ourselves. That blend is exactly what could never be
 *  made to match: CoreText's rasterization of light-on-dark text carries its own gamma and
 *  smoothing compensation, so re-mixing its coverage in the shader was a tuning knob with no
 *  correct setting (six device rounds of BLEND_GAMMA say so). xterm's own TextureAtlas asks the
 *  platform to draw the glyph in its REAL colours over its REAL background and blits the result
 *  1:1; keying on the colours is the price of that, and it is the price this file now pays.
 *
 *  The key space therefore grows with the palette, which is what `reset()` below is for. */
export interface GlyphRasterizer {
  cellW: number
  cellH: number
  /** Paint one slot. `x, y` is the INK origin in page pixels (already one gutter inside the pitch
   *  cell — see GUTTER_PX); `fg`/`bg` are packColor lanes, the FINAL per-cell colours with
   *  selection/cursor already applied by the caller. */
  draw(
    code: number,
    bold: boolean,
    italic: boolean,
    x: number,
    y: number,
    fg: number,
    bg: number
  ): void
  /** Blank the whole page. Called by `GlyphAtlas.reset()` and by nothing else: the bookkeeping and
   *  the pixels have to be emptied in the same breath or a stale slot keeps its old ink. */
  clearPage(): void
  readonly source: TexImageSource | null
}

/**
 * The ink-free margin, in page texels, on EVERY side of a slot's cell rect. Exported because three
 * modules have to agree on it: this file lays the page out with it, raster.ts fills it with the
 * slot's own background colour, and gl-webgl2.ts offsets its uv derivation by it.
 *
 * WHY 2 — the derivation, since this number is what bounds the usable mip chain. A mip level-n
 * texel is the average of an aligned 2^n × 2^n block of level-0 texels. Two slots' inks are
 * separated by 2*GUTTER_PX = 4 texels of gutter (this slot's plus the neighbour's), so a level-n
 * block can only contain ink from BOTH slots once it is wider than that separation, i.e. once
 * 2^n > 4 → n >= 3. Levels 0, 1 and 2 therefore never mix a foreign glyph into this slot, which is
 * why gl-webgl2 clamps TEXTURE_MAX_LOD to MAX_SAFE_LOD = 2.
 *
 * What the gutter does NOT promise, stated so nobody reads more into it: bilinear filtering WITHIN
 * a level still reaches the adjacent texel, which at level 2 can be a pure-gutter texel holding a
 * blend of this slot's background and the neighbour's. That is a soft edge between two BACKGROUND
 * colours at heavy zoom-out — never a ghost glyph — and it is the residual the LOD clamp accepts.
 * The promise is about INK, and it holds only while raster.ts keeps ink inside the cell rect: ink
 * allowed to overhang into the gutter shortens the ink-to-ink separation and invalidates the
 * derivation above.
 */
export const GUTTER_PX = 2

/** The slot PITCH for a cell extent, in whole texels — the ONE copy of that arithmetic.
 *
 *  Exported because raster.ts needs the identical number: the atlas lays the page out on this
 *  pitch and the rasterizer fills exactly one pitch rect per slot with that slot's background.
 *  Two hand-written copies would drift the moment the gutter or the rounding changed, and the
 *  symptom is a background fill that either leaves a page-ground seam or overwrites a neighbour's
 *  gutter. See `GlyphAtlas.strideX` for why the pitch is rounded and the sampled extent is not. */
export function slotPitch(cell: number): number {
  return Math.max(1, Math.ceil(cell)) + 2 * GUTTER_PX
}

/** One slot allocation, reported to an optional debug tap. See `GlyphAtlas`'s constructor.
 *
 *  This exists for ONE open device bug: a single letter (`ç` in round 5, lowercase `x` in round 7)
 *  renders BLANK while its neighbours are fine. Every headless-auditable path was audited and is
 *  clean — box-glyphs claims nothing below U+0300 and never returns an empty op list, the raster
 *  repaints the slot's whole PITCH rect (unclipped, before the cell clip is installed) ahead of the
 *  ink on BOTH branches, `cellXY` is the single copy of the layout math and the shader recomputes it
 *  identically, `strideX >= cellW + 2*GUTTER_PX` always (the rasterizer's cell is captured at
 *  construction and never re-adopted), and the atlas's dirty flag is polled by the rAF driver every
 *  frame, so no wake-up can be missed. What is left needs a real font on a real device, which no
 *  test here can produce — so the next round collects evidence instead of guessing. */
export interface GlyphSlotAllocation {
  slot: number
  code: number
  bold: boolean
  italic: boolean
  /** Page-pixel INK origin the glyph was drawn at — `cellXY(slot)`. */
  x: number
  y: number
  /** The packed colour lanes the slot was rasterized in — part of its key. */
  fg: number
  bg: number
}

/** What `onReset` hands back. A plain disposable rather than an unsubscribe function so the call
 *  sites read the same as every other subscription in the renderer. */
export interface GlyphAtlasSubscription {
  dispose(): void
}

export class GlyphAtlas {
  private slots = new Map<string, number>()
  /** Slot 0 is permanently blank and is never handed to the rasterizer: every space, every
   *  unknown code point and every cell of a not-yet-uploaded GPU buffer samples it. Its
   *  BLANKNESS is a contract on raster.ts — the page starts blank and nothing may ever draw into
   *  slot 0 — not something this file can enforce, so the two must change together. If ink ever
   *  lands there, every space on the canvas grows a glyph. Slot 0 is NOT a special case in the
   *  layout: it sits inside the same gutter every other slot does, so its mip neighbourhood is
   *  free of slot 1's ink for the same reason theirs are free of each other's. */
  private nextSlot = 1
  private dirtyFlag = false
  private resets = 0
  private resetSubs = new Set<() => void>()
  /** True only while `reset()` is notifying subscribers. See the guard in `glyphFor`. */
  private inReset = false

  constructor(
    private rasterizer: GlyphRasterizer,
    private pageSizePx = 1024,
    /** Optional DEBUG tap, called once per slot allocation (never on a cache hit, never for the
     *  blank slot). Off in production — the shell only passes one when the device-debug flag is
     *  set. It must never be able to break rendering, so it is called inside a try/catch AFTER the
     *  ink and the bookkeeping are already committed. */
    private onAllocate?: (info: GlyphSlotAllocation) => void
  ) {}

  /** The metrics `GlyphGL.uploadAtlas` needs to map a slot index to texels. They are
   *  passthroughs on purpose: the page size is the atlas's own, the cell size belongs to the
   *  rasterizer that filled it, and the engine must never have to know a second source for
   *  either — a mismatch here shifts every glyph by a fraction of a cell. */
  get sizePx(): number {
    return this.pageSizePx
  }
  /** The SAMPLED extent of a slot, in texels: exactly the device cell the grids draw with, which
   *  is fractional in general (xterm's `device.cell.width` is `charWidth * dpr`). Keeping it
   *  exact is what makes the texel:pixel mapping 1:1 at zoom 1 — see `strideX`. */
  get cellW(): number {
    return this.rasterizer.cellW
  }
  get cellH(): number {
    return this.rasterizer.cellH
  }

  /**
   * The slot PITCH, in whole texels — the cell rounded UP plus a gutter on each side, so
   * consecutive slots share neither a texel nor a mip neighbourhood.
   *
   * Pitch and extent are separate for one reason. Rounding the CELL to whole texels (what this
   * atlas used to do) means a glyph rasterized into N texels is drawn onto a quad of N±0.5
   * device pixels: the GPU resamples every glyph by a couple of percent, which is precisely the
   * "rougher than the DOM renderer" report. Rounding only the PITCH keeps the extent exact —
   * texel:pixel 1:1 — while still starting every slot on a texel boundary, which matters because
   * a fractional origin would put two neighbouring glyphs' anti-aliasing in the SAME boundary
   * texel, and a full-block glyph would then bleed a dim column into an unrelated slot.
   *
   * The gutter rides on the PITCH, not on the extent: growing the sampled extent would pull the
   * neighbouring backdrop into every glyph at zoom 1, which is the opposite of the point.
   *
   * The `max(1, …)` is not decoration: without it a sub-texel cell would round to a 0-texel ink
   * box, and `capacity`/`cellXY` would count slots that cannot hold a pixel.
   */
  get strideX(): number {
    return slotPitch(this.rasterizer.cellW)
  }
  get strideY(): number {
    return slotPitch(this.rasterizer.cellH)
  }

  get capacity(): number {
    const cols = Math.floor(this.sizePx / this.strideX)
    const rows = Math.floor(this.sizePx / this.strideY)
    return cols * rows
  }

  /** How many times the page has been cleared and re-filled. Read by the device-debug log line —
   *  resets are expected to be rare, and "how rare" is the number that decides whether the v1
   *  reset-on-full model needs the Phase-2 escalation to real LRU eviction. */
  get resetCount(): number {
    return this.resets
  }

  /** Row-major INK origin of a slot, in page PIXELS — the single copy of the layout math.
   *
   *  Both consumers must agree exactly: `glyphFor` uses it to place the ink and `slotRect` to
   *  derive the uv rect the shader samples. Two hand-written copies would drift the moment
   *  either the page metrics or the gutter changed, and the symptom is every glyph rendering
   *  a fraction of a cell off — not a crash, just permanently wrong text.
   *
   *  The pitch cell's corner is `(slot % cols) * strideX`; the INK starts one gutter inside it on
   *  each axis, which is what leaves the ink-free margin the mip chain needs (see GUTTER_PX).
   *
   *  On a DEGENERATE page (`sizePx < strideX`, so `cols === 0`) `slot % 0` is NaN, which would
   *  propagate silently into the uv rect. Capacity is 0 there, so no slot is ever allocated and
   *  the origin is simply (0,0) — the blank slot. */
  private cellXY(slot: number): { x: number; y: number } {
    const cols = Math.floor(this.sizePx / this.strideX)
    if (cols <= 0) return { x: 0, y: 0 }
    return {
      x: (slot % cols) * this.strideX + GUTTER_PX,
      y: Math.floor(slot / cols) * this.strideY + GUTTER_PX
    }
  }

  /**
   * Subscribe to page resets. Fired AFTER the page has been blanked and the bookkeeping emptied,
   * and BEFORE the allocation that triggered the reset lands — so a subscriber that repacks
   * immediately packs into the fresh page and can never write a lane pointing at a slot that no
   * longer holds what it held.
   *
   * A subscriber MAY call back into `glyphFor` — that is what a repack is — and the reset path is
   * re-entrancy-GUARDED, not merely re-entrancy-safe: while subscribers are running, an allocation
   * that would trigger a reset returns the BLANK slot instead (`inReset`). A repack needing more
   * keys than the fresh page holds is a real case, and letting it reset again would clear the page
   * that same repack is half-way through writing — measured, on a page with one usable slot and a
   * subscriber asking for three, as unbounded recursion into a stack overflow that the
   * per-subscriber catch below then SWALLOWED, leaving a half-packed page and no error anywhere.
   * Degrading instead costs those cells one frame of blank: the next repack round re-requests them,
   * and a page genuinely too small for the canvas is the LRU escalation's problem, not a
   * recursion's.
   *
   * That guard is a floor, not the intended path. A full repack inside someone else's pack loop is
   * the wrong SHAPE for a subscriber, which is why the renderer addon answers a reset by requesting
   * a full REDRAW (see `handleAtlasReset`) and lets xterm's render pass do the packing outside this
   * notification — where the guard above never has to degrade anything to blank.
   */
  onReset(cb: () => void): GlyphAtlasSubscription {
    this.resetSubs.add(cb)
    return {
      dispose: () => {
        this.resetSubs.delete(cb)
      }
    }
  }

  /**
   * Clear the page and start over — xterm's `clearTextureAtlas` model.
   *
   * Colour keys grow with the palette, so a single page WILL fill on a busy canvas. The
   * alternative, evicting one slot at a time, has a dangling-slot problem this design does not:
   * a lane already uploaded to the GPU keeps pointing at the evicted slot and silently renders
   * whatever glyph reused it. After a reset NO lane is valid, subscribers are told exactly that,
   * and every row is repacked — one expensive frame instead of a permanent class of wrong pixels.
   */
  private reset(): void {
    this.slots.clear()
    this.nextSlot = 1
    this.rasterizer.clearPage()
    // Counted only once the page is actually blank: `resetCount` is read as "how many times this
    // atlas started over", and a clearPage() that threw must not leave a count claiming it did.
    this.resets++
    this.dirtyFlag = true
    // The subscriber that matters is the renderer addon (one per attached terminal), which answers
    // by asking xterm for a full redraw — deferred, never a repack from inside this notification.
    // A page with NO subscriber (the dev harness feeds the engine directly) keeps rendering its
    // already-uploaded lanes against the fresh page, i.e. wrong glyphs until something repacks it.
    this.inReset = true
    try {
      // Iterate a COPY: a subscriber is allowed to dispose itself (or another) from inside its own
      // callback, and mutating the live set mid-iteration would skip the next subscriber.
      for (const cb of [...this.resetSubs]) {
        try {
          cb()
        } catch (err) {
          // One broken repack must not cost the other subscribers their notification — nor the
          // frame. The page is already consistent by the time we get here.
          console.warn('[glyphgrid] atlas onReset subscriber threw:', err)
        }
      }
    } finally {
      // `finally`, so a throw that escapes the loop (it cannot today — every callback is caught —
      // but a future edit to that catch would) can never leave the atlas permanently unable to
      // reset again.
      this.inReset = false
    }
  }

  glyphFor(code: number, bold: boolean, italic: boolean, fg: number, bg: number): number {
    if (code === 0x20 || code === 0) return 0
    // `>>> 0` on both lanes: `0xff << 24` is NEGATIVE in JS (packColor carries the same note), so
    // one colour can arrive as -16777216 from an arithmetic path and as 4278190080 off a cell
    // lane. Keying the two spellings separately would put identical pixels in two slots — wasted
    // page, and resets arriving twice as fast.
    const key = `${code}|${bold ? 1 : 0}${italic ? 1 : 0}|${fg >>> 0}|${bg >>> 0}`
    const hit = this.slots.get(key)
    if (hit !== undefined) return hit
    if (this.nextSlot >= this.capacity) {
      // A page with room for nothing but the blank slot (capacity <= 1, degenerate pages
      // included) can never satisfy this request: resetting would blank an empty page and notify
      // every subscriber on EVERY glyph, forever. Degrade to blank instead.
      if (this.capacity <= 1) return 0
      // RE-ENTRANCY GUARD: we are inside reset()'s notification, i.e. a subscriber's repack, and
      // it has already refilled the fresh page. Resetting again would clear the very page that
      // repack is writing and recurse without bound (measured: stack overflow, swallowed by the
      // per-subscriber catch, page left half-packed). Degrade instead — this cell is blank for one
      // frame and the NEXT repack round re-requests it. See `onReset`.
      if (this.inReset) return 0
      this.reset()
      // A subscriber may have repacked enough rows to fill the fresh page again. Degrade to blank
      // rather than allocate off the end of the page.
      if (this.nextSlot >= this.capacity) return 0
    }
    const slot = this.nextSlot++
    const { x, y } = this.cellXY(slot)
    this.rasterizer.draw(code, bold, italic, x, y, fg, bg)
    this.slots.set(key, slot)
    this.dirtyFlag = true
    // LAST, and guarded: the tap is a debug aid, so a throwing callback must cost a log line, not
    // the glyph — everything above is already committed by the time it runs.
    if (this.onAllocate) {
      try {
        this.onAllocate({ slot, code, bold, italic, x, y, fg, bg })
      } catch {
        /* a debug tap never breaks a frame */
      }
    }
    return slot
  }

  /** The uv rect of a slot: the ORIGIN is the ink origin (pitch cell + gutter), the SIZE is the
   *  exact cell — the three numbers are not interchangeable (see `strideX` and `GUTTER_PX`).
   *
   *  The shader derives the same rect per vertex (`uAtlasStride` for the pitch, `uAtlasGutter` for
   *  the origin offset, `uAtlasCell` for the extent) rather than reading it from here, because it
   *  has only the slot INDEX in the cell lane. This rect and the uv-tie test that transcribes it
   *  are the CPU-side truth that derivation has to keep agreeing with. */
  slotRect(slot: number): { u0: number; v0: number; u1: number; v1: number } {
    // A degenerate page has no sampleable area at all: return the ZERO rect rather than let the
    // division produce NaN, which the shader would turn into undefined texture reads.
    if (this.capacity <= 0) return { u0: 0, v0: 0, u1: 0, v1: 0 }
    const { x, y } = this.cellXY(slot)
    return {
      u0: x / this.sizePx,
      v0: y / this.sizePx,
      u1: (x + this.rasterizer.cellW) / this.sizePx,
      v1: (y + this.rasterizer.cellH) / this.sizePx
    }
  }

  get dirty(): boolean {
    return this.dirtyFlag
  }
  clearDirty(): void {
    this.dirtyFlag = false
  }
  get source(): TexImageSource | null {
    return this.rasterizer.source
  }
}
