import { describe, expect, it } from 'vitest'
import { unpackColor } from '../glyphgrid/cells'
import {
  DEFAULT_TERMINAL_BG,
  bodyPlateRect,
  bodyWorldRect,
  packThemeBg,
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

describe('bodyPlateRect', () => {
  it('is the body box in world space: node position + body offset, at the body client size', () => {
    expect(bodyPlateRect({ x: 100, y: 200 }, { x: 0, y: 28 }, 480, 300)).toEqual({
      x: 100,
      y: 228,
      w: 480,
      h: 300
    })
  })

  it('CONTAINS a grid the cell fit could not fill — the whole point of the rect', () => {
    // The reported defect, in numbers. A 300px-tall body at a 20px cell fits 15 rows exactly, but
    // a 310px one fits 15 and letterboxes 10px; the host's padding (4px top, 2px bottom) does not
    // reach that. The plate is the BODY, so the band is inside it whatever the fit leaves over.
    const plate = bodyPlateRect({ x: 0, y: 0 }, { x: 0, y: 0 }, 500, 310)
    const gridBottom = 4 + 15 * 20 // body padding-top + the rows that fit
    expect(plate.h).toBeGreaterThan(gridBottom)
    expect(plate.y + plate.h).toBe(310)
  })

  it('handles negative world positions (the canvas has no origin quadrant)', () => {
    expect(bodyPlateRect({ x: -1200.5, y: -40 }, { x: 6, y: 34 }, 200, 100)).toEqual({
      x: -1194.5,
      y: -6,
      w: 200,
      h: 100
    })
  })

  it('collapses a non-finite extent to 0 rather than propagating NaN into a GL scissor', () => {
    // An element that is not laid out yet reports a garbage/zero client box. 0 is a rect the
    // plate math answers `null` for (skip the clear); NaN would reach glScissor.
    expect(bodyPlateRect({ x: 0, y: 0 }, { x: 0, y: 0 }, NaN, 100)).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 100
    })
    expect(bodyPlateRect({ x: 0, y: 0 }, { x: 0, y: 0 }, 100, Infinity)).toMatchObject({ h: 0 })
  })

  it('collapses a negative extent to 0', () => {
    expect(bodyPlateRect({ x: 0, y: 0 }, { x: 0, y: 0 }, -20, -1)).toMatchObject({ w: 0, h: 0 })
  })

  it('shares its origin with bodyWorldRect — one sum, two callers', () => {
    const pos = { x: 12.5, y: -3 }
    const off = { x: 6, y: 34 }
    const origin = bodyWorldRect(pos, off)
    const plate = bodyPlateRect(pos, off, 10, 10)
    expect({ x: plate.x, y: plate.y }).toEqual(origin)
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
