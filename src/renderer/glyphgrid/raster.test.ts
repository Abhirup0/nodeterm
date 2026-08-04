import { afterEach, describe, expect, it } from 'vitest'
import { GlyphAtlas, GUTTER_PX } from './atlas'
import { packColor } from './cells'
import { createCanvasRasterizer } from './raster'

/**
 * These tests pin the two rects a colored draw uses, because the whole mip story rests on them:
 * the slot's own BACKGROUND covers the FULL PITCH rect (gutter included — that is what makes a
 * level-1/2 texel blend this slot's background with itself rather than with the page ground),
 * while the INK is clipped to the CELL rect and may never touch the gutter (the MAX_SAFE_LOD = 2
 * derivation in `atlas.ts` counts on 2*GUTTER_PX clean texels between two slots' inks).
 *
 * Node has no OffscreenCanvas, so the contract is checked against a recording stub rather than
 * real pixels.
 */

interface Op {
  kind: 'fillRect' | 'fillText' | 'clip' | 'clearRect'
  fill?: string
  args: number[]
  text?: string
}

function stubCanvas(): { ops: Op[]; restore: () => void } {
  const ops: Op[] = []
  const ctx = {
    font: '',
    textBaseline: '',
    fillStyle: '',
    save() {},
    restore() {},
    beginPath() {},
    rect(x: number, y: number, w: number, h: number) {
      ops.push({ kind: 'clip', args: [x, y, w, h] })
    },
    clip() {},
    fillRect(x: number, y: number, w: number, h: number) {
      ops.push({ kind: 'fillRect', fill: ctx.fillStyle, args: [x, y, w, h] })
    },
    clearRect(x: number, y: number, w: number, h: number) {
      ops.push({ kind: 'clearRect', args: [x, y, w, h] })
    },
    fillText(text: string, x: number, y: number) {
      ops.push({ kind: 'fillText', fill: ctx.fillStyle, args: [x, y], text })
    },
    // A face whose line box exactly fills a 20px cell, so the baseline math is not the subject.
    measureText: () => ({ fontBoundingBoxAscent: 16, fontBoundingBoxDescent: 4 })
  }
  const prev = (globalThis as Record<string, unknown>).OffscreenCanvas
  ;(globalThis as Record<string, unknown>).OffscreenCanvas = class {
    constructor(
      public width: number,
      public height: number
    ) {}
    getContext(): unknown {
      return ctx
    }
  }
  return {
    ops,
    restore() {
      ;(globalThis as Record<string, unknown>).OffscreenCanvas = prev
    }
  }
}

const FONT = { family: 'monospace', sizePx: 16, cellW: 10, cellH: 20 }
/** The pitch this font lays out on: ceil(cell) + a gutter on each side. */
const PITCH_W = 10 + 2 * GUTTER_PX
const PITCH_H = 20 + 2 * GUTTER_PX

/** A realistic INK origin — the corner of a pitch cell plus one gutter on each axis, which is
 *  exactly what `GlyphAtlas.cellXY` hands the rasterizer. */
const INK_X = PITCH_W + GUTTER_PX
const INK_Y = PITCH_H + GUTTER_PX

/** Final packed colour lanes, deliberately not black/white so a swapped fg/bg is visible. */
const FG = packColor(255, 160, 0, 255)
const BG = packColor(16, 32, 48, 255)
const FG_CSS = 'rgb(255,160,0)'
const BG_CSS = 'rgb(16,32,48)'

let active: { restore: () => void } | null = null
afterEach(() => {
  active?.restore()
  active = null
})

describe('createCanvasRasterizer', () => {
  it('degrades to null (caller keeps the DOM renderer) when OffscreenCanvas is unavailable', () => {
    const prev = (globalThis as Record<string, unknown>).OffscreenCanvas
    delete (globalThis as Record<string, unknown>).OffscreenCanvas
    expect(createCanvasRasterizer(FONT, 256)).toBeNull()
    ;(globalThis as Record<string, unknown>).OffscreenCanvas = prev
  })

  it('paints NOTHING at creation — the page ground stays transparent-black', () => {
    const stub = stubCanvas()
    active = stub
    createCanvasRasterizer(FONT, 256)
    // The old opaque-black page fill is GONE: the backdrop is now per-slot (the bg fill in
    // `draw`), and a page-wide fill would put an opaque colour in slot 0, which every space
    // samples.
    expect(stub.ops).toEqual([])
  })

  it('fills the FULL PITCH rect with bg, then clips the ink to the CELL rect and draws it in fg', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    r.draw(0x41, false, false, INK_X, INK_Y, FG, BG)

    // 1. The background covers the pitch cell — its origin is the INK origin minus one gutter on
    //    each axis, and its extent is the whole pitch (gutters included).
    expect(stub.ops[0]).toEqual({
      kind: 'fillRect',
      fill: BG_CSS,
      args: [INK_X - GUTTER_PX, INK_Y - GUTTER_PX, PITCH_W, PITCH_H]
    })
    // 2. The ink is clipped to the CELL rect, which starts at the ink origin.
    expect(stub.ops[1]).toEqual({ kind: 'clip', args: [INK_X, INK_Y, FONT.cellW, FONT.cellH] })
    // 3. The glyph itself, in the foreground colour.
    const ink = stub.ops[2]
    expect(ink.kind).toBe('fillText')
    expect(ink.text).toBe('A')
    expect(ink.fill).toBe(FG_CSS)
    // Baseline: unchanged half-leading convention, now measured from the ink origin (i.e. inside
    // the cell rect, one gutter into the pitch cell), on a WHOLE device pixel.
    expect(ink.args[0]).toBe(INK_X)
    expect(ink.args[1]).toBe(INK_Y + 16)
    expect(Number.isInteger(ink.args[1])).toBe(true)
  })

  it('keeps every ink op inside the CELL rect — the gutter must stay clean for the mip chain', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    r.draw(0x2588, false, false, INK_X, INK_Y, FG, BG) // █ — the glyph that fills the whole cell

    const ink = stub.ops.filter((o) => o.kind === 'fillRect' && o.fill === FG_CSS)
    expect(ink.length).toBeGreaterThan(0)
    for (const op of ink) {
      const [x, y, w, h] = op.args
      expect(x).toBeGreaterThanOrEqual(INK_X)
      expect(y).toBeGreaterThanOrEqual(INK_Y)
      expect(x + w).toBeLessThanOrEqual(INK_X + FONT.cellW)
      expect(y + h).toBeLessThanOrEqual(INK_Y + FONT.cellH)
    }
    // And the only fill that is allowed outside the cell is the background one, which is exactly
    // the pitch rect.
    const outside = stub.ops.filter(
      (o) =>
        o.kind === 'fillRect' &&
        (o.args[0] < INK_X ||
          o.args[1] < INK_Y ||
          o.args[0] + o.args[2] > INK_X + FONT.cellW ||
          o.args[1] + o.args[3] > INK_Y + FONT.cellH)
    )
    expect(outside).toEqual([
      {
        kind: 'fillRect',
        fill: BG_CSS,
        args: [INK_X - GUTTER_PX, INK_Y - GUTTER_PX, PITCH_W, PITCH_H]
      }
    ])
  })

  it('draws the geometric box/block glyphs in the FOREGROUND over the bg fill, never with the font', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    r.draw(0x2591, false, false, INK_X, INK_Y, FG, BG) // ░ — a stipple, fg pixels over bg

    expect(stub.ops.some((o) => o.kind === 'fillText')).toBe(false)
    const fills = stub.ops.filter((o) => o.kind === 'fillRect')
    expect(fills[0].fill).toBe(BG_CSS) // the slot's own backdrop, first
    expect(fills.slice(1).every((o) => o.fill === FG_CSS)).toBe(true)
    expect(fills.length).toBeGreaterThan(1)
  })

  it('converts both packed lanes to css rgb(), reading the RGB lanes in packColor order', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    // A colour whose channels are all different, so a swapped r/b lane cannot pass.
    r.draw(0x41, false, false, INK_X, INK_Y, packColor(1, 2, 3, 255), packColor(4, 5, 6, 255))
    expect(stub.ops[0].fill).toBe('rgb(4,5,6)')
    expect(stub.ops.find((o) => o.kind === 'fillText')!.fill).toBe('rgb(1,2,3)')
  })

  it('keys off the UNSIGNED lanes — a negative packed colour is the same colour', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    // `0xff << 24` is negative in JS; an arithmetic path can hand us that spelling.
    r.draw(0x41, false, false, INK_X, INK_Y, (0xff << 24) | 0x0000ff, (0xff << 24) | 0x00ff00)
    expect(stub.ops[0].fill).toBe('rgb(0,255,0)')
    expect(stub.ops.find((o) => o.kind === 'fillText')!.fill).toBe('rgb(255,0,0)')
  })

  it('clearPage() blanks the whole page back to transparent-black', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    r.clearPage()
    // clearRect, NOT a fill: the page ground has to go back to transparent-black so slot 0 stays
    // the blank slot every space samples.
    expect(stub.ops).toEqual([{ kind: 'clearRect', args: [0, 0, 256, 256] }])
  })

  it('never draws slot 0, so the blank slot every space samples stays transparent', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    const atlas = new GlyphAtlas(r, 256)
    stub.ops.length = 0
    expect(atlas.glyphFor(0x20, false, false, FG, BG)).toBe(0)
    expect(stub.ops).toEqual([])
    // The first real glyph starts at slot 1 — i.e. past the origin cell. Not even its background
    // fill may reach slot 0's pitch rect.
    atlas.glyphFor(0x41, false, false, FG, BG)
    expect(stub.ops.some((o) => o.args[0] < PITCH_W && o.args[1] < PITCH_H)).toBe(false)
  })
})
