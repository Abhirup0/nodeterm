import { describe, expect, it } from 'vitest'
import { unpackColor } from '../glyphgrid/cells'
import {
  DEFAULT_TERMINAL_BG,
  bodyWorldRect,
  packThemeBg,
  platePadPx,
  validCellSize
} from './glyphGridNode'

describe('bodyWorldRect', () => {
  it('adds the body offset to the node position', () => {
    expect(bodyWorldRect({ x: 100, y: 200 }, { x: 6, y: 34 })).toEqual({ x: 106, y: 234 })
  })

  it('handles negative world positions (the canvas has no origin quadrant)', () => {
    expect(bodyWorldRect({ x: -1200.5, y: -40 }, { x: 6, y: 34 })).toEqual({ x: -1194.5, y: -6 })
  })

  it('is a pure sum — a zero offset leaves the node position untouched', () => {
    expect(bodyWorldRect({ x: 7, y: 9 }, { x: 0, y: 0 })).toEqual({ x: 7, y: 9 })
  })
})

describe('platePadPx', () => {
  it('takes the MAXIMUM side, so no padded strip is left uncovered', () => {
    // .term-node__xterm's real padding: 4px 2px 2px 6px. The node body is transparent under
    // `.term-node--glyphgrid`, so a strip the plate misses shows raw canvas while one it
    // over-covers hides under the node's own opaque chrome — the max leaves nothing bare.
    expect(platePadPx({ top: 4, right: 2, bottom: 2, left: 6 })).toBe(6)
  })

  it('passes a symmetric padding through', () => {
    expect(platePadPx({ top: 8, right: 8, bottom: 8, left: 8 })).toBe(8)
  })

  it('is 0 for a zero padding — the plate is then exactly the grid rect', () => {
    expect(platePadPx({ top: 0, right: 0, bottom: 0, left: 0 })).toBe(0)
  })

  it('collapses negative sides to 0 rather than growing the rect off a bad parse', () => {
    expect(platePadPx({ top: -4, right: -2, bottom: -2, left: -6 })).toBe(0)
  })

  it('collapses an unparseable (NaN) side to 0', () => {
    expect(platePadPx({ top: NaN, right: 2, bottom: 2, left: 6 })).toBe(0)
  })
})

describe('packThemeBg', () => {
  const rgba = (n: number) => unpackColor(n)

  it('packs #rrggbb opaquely', () => {
    expect(rgba(packThemeBg('#1e1e1e'))).toEqual({ r: 0x1e, g: 0x1e, b: 0x1e, a: 0xff })
  })

  it('expands the #rgb short form', () => {
    expect(rgba(packThemeBg('#abc'))).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 0xff })
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(packThemeBg('  #1E1E1E ')).toBe(packThemeBg('#1e1e1e'))
  })

  it('forces alpha opaque even for a colour the caller thinks is translucent', () => {
    // #rrggbbaa is NOT parsed (see the doc comment) — it falls back, still opaque.
    expect(rgba(packThemeBg('#1e1e1e80')).a).toBe(0xff)
  })

  it('falls back to the terminal default for undefined / unknown forms', () => {
    const fallback = packThemeBg(DEFAULT_TERMINAL_BG)
    expect(packThemeBg(undefined)).toBe(fallback)
    expect(packThemeBg('black')).toBe(fallback)
    expect(packThemeBg('rgb(30,30,30)')).toBe(fallback)
    expect(packThemeBg('#12345')).toBe(fallback)
    expect(packThemeBg('#zzzzzz')).toBe(fallback)
  })
})

describe('validCellSize', () => {
  it('accepts a real measured cell', () => {
    expect(validCellSize(8.5, 17)).toEqual({ cellW: 8.5, cellH: 17 })
  })

  it('refuses zero / negative / non-finite measurements (a not-yet-laid-out terminal)', () => {
    expect(validCellSize(0, 17)).toBeNull()
    expect(validCellSize(8, 0)).toBeNull()
    expect(validCellSize(-8, 17)).toBeNull()
    expect(validCellSize(NaN, 17)).toBeNull()
    expect(validCellSize(8, Infinity)).toBeNull()
  })
})
