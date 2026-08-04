import { afterEach, describe, expect, it } from 'vitest'
import { GlyphAtlas } from './atlas'
import { createCanvasRasterizer } from './raster'

/**
 * These tests exist for ONE reason: the atlas page is opaque black with white ink, and the shader
 * reads coverage off the RED channel (`gl-webgl2.ts`). If this file ever goes back to rasterizing
 * onto transparency — which is what made plain text render thinner than the per-terminal
 * WebglAddon on macOS — the shader reads 0 everywhere and the terminal goes blank. Node has no
 * OffscreenCanvas, so the contract is checked against a recording stub rather than real pixels.
 */

interface Op {
  kind: 'fillRect' | 'fillText' | 'clip'
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

  it('paints the WHOLE page opaque black once at creation — the backdrop coverage 0 means', () => {
    const stub = stubCanvas()
    active = stub
    createCanvasRasterizer(FONT, 256)
    expect(stub.ops).toEqual([{ kind: 'fillRect', fill: '#000000', args: [0, 0, 256, 256] }])
  })

  it('re-blacks a slot inside its clip, then draws WHITE ink over that backdrop', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    r.draw(0x41, false, false, 10, 20) // 'A' into the slot at (10,20)

    expect(stub.ops[0]).toEqual({ kind: 'clip', args: [10, 20, 10, 20] })
    // The black fill is the slot's own rect — never the page, and the clip above keeps it off the
    // neighbouring slots even if a future cell size disagreed.
    expect(stub.ops[1]).toEqual({ kind: 'fillRect', fill: '#000000', args: [10, 20, 10, 20] })
    const ink = stub.ops[2]
    expect(ink.kind).toBe('fillText')
    expect(ink.text).toBe('A')
    expect(ink.fill).toBe('#ffffff')
    // Baseline: half-leading of a line box that exactly fills the cell → the ascent, on a WHOLE
    // device pixel (a fractional baseline would give each glyph a different NEAREST cut).
    expect(ink.args[1]).toBe(20 + 16)
    expect(Number.isInteger(ink.args[1])).toBe(true)
  })

  it('draws the geometric box/block glyphs as WHITE rects (coverage 1), never with the font', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    stub.ops.length = 0
    r.draw(0x2588, false, false, 0, 0) // █ full block

    expect(stub.ops.some((o) => o.kind === 'fillText')).toBe(false)
    const fills = stub.ops.filter((o) => o.kind === 'fillRect')
    expect(fills[0].fill).toBe('#000000') // the slot's backdrop
    expect(fills.slice(1).every((o) => o.fill === '#ffffff')).toBe(true)
    expect(fills.length).toBeGreaterThan(1)
  })

  it('never draws slot 0, so the blank slot every space samples stays black', () => {
    const stub = stubCanvas()
    active = stub
    const r = createCanvasRasterizer(FONT, 256)!
    const atlas = new GlyphAtlas(r, 256)
    stub.ops.length = 0
    expect(atlas.glyphFor(0x20, false, false)).toBe(0)
    expect(stub.ops).toEqual([])
    // The first real glyph starts at slot 1 — i.e. past the origin cell.
    atlas.glyphFor(0x41, false, false)
    expect(stub.ops.some((o) => o.args[0] === 0 && o.args[1] === 0)).toBe(false)
  })
})
