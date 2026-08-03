import { describe, expect, it } from 'vitest'
import type { GridDrawParams } from './gl'
import { plateRectDevice } from './plate'

/** A 5×2 grid of 8×20 cells → a 40×40 world rect at the given origin. */
const grid = (over: Partial<GridDrawParams> = {}): GridDrawParams => ({
  id: 'a',
  cols: 5,
  rows: 2,
  cellW: 8,
  cellH: 20,
  originX: 10,
  originY: 10,
  bgColor: 0,
  padPx: 0,
  ...over
})

const CAM = { x: 0, y: 0, zoom: 1 }

describe('plateRectDevice', () => {
  it('flips Y against the drawing buffer height', () => {
    // Derived by hand. World rect (10,10)-(50,50) at zoom 1, pan 0 → the same in CSS px. At
    // dpr 1 that is device px too. GL's scissor origin is BOTTOM-left, so the rect's device y is
    // the distance from the buffer's BOTTOM to the rect's BOTTOM edge: 100 - 50 = 50.
    expect(plateRectDevice(grid(), CAM, 1, 200, 100)).toEqual({ x: 10, y: 50, w: 40, h: 40 })
  })

  it('scales into device pixels by dpr, not by devicePixelRatio at call time', () => {
    // Same world rect at dpr 2 against a 400×200 drawing buffer: every extent doubles and the
    // flip is taken against the DEVICE height (200 - (20 + 80) = 100), never the CSS one.
    expect(plateRectDevice(grid(), CAM, 2, 400, 200)).toEqual({ x: 20, y: 100, w: 80, h: 80 })
  })

  it('applies the camera: pan then zoom, exactly as the vertex shader does', () => {
    // screen = world * zoom + pan. Origin (10,10) at zoom 2 pan (5,5) → CSS (25,25), extent 80.
    // Flip: 200 - (25 + 80) = 95.
    expect(plateRectDevice(grid(), { x: 5, y: 5, zoom: 2 }, 1, 400, 200)).toEqual({
      x: 25,
      y: 95,
      w: 80,
      h: 80
    })
  })

  it('expands the rect by padPx on every side, in world units', () => {
    // padPx 5 grows the 40×40 rect to 50×50 and moves its top-left to (5,5).
    // Flip: 100 - (5 + 50) = 45.
    expect(plateRectDevice(grid({ padPx: 5 }), CAM, 1, 200, 100)).toEqual({
      x: 5,
      y: 45,
      w: 50,
      h: 50
    })
  })

  it('clamps to the drawing buffer instead of returning a negative origin or extent', () => {
    // Origin (-10,-10): the rect hangs off the left and the top. A scissor rect may legally sit
    // outside the viewport, but pushing the origin to 0 without shrinking the extent would move
    // the far edge — and a NEGATIVE extent is a GL_INVALID_VALUE.
    // Visible CSS span: x 0..30, y 0..30 → device y from 100-30 = 70, height 30.
    expect(plateRectDevice(grid({ originX: -10, originY: -10 }), CAM, 1, 200, 100)).toEqual({
      x: 0,
      y: 70,
      w: 30,
      h: 30
    })
  })

  it('is null when the rect is entirely off-screen', () => {
    // Null, not a zero-area rect: the caller must SKIP the clear, and a {w:0,h:0} scissor would
    // still cost the state changes around it.
    expect(plateRectDevice(grid({ originX: 500 }), CAM, 1, 200, 100)).toBeNull()
    expect(plateRectDevice(grid({ originY: -500 }), CAM, 1, 200, 100)).toBeNull()
  })

  it('is null when the rect touches an edge without covering a pixel', () => {
    // A 40-wide rect at x=-40 ends exactly at x=0: it shares an edge with the viewport and
    // covers zero pixels, so it must be null rather than a zero-width scissor.
    expect(plateRectDevice(grid({ originX: -40 }), CAM, 1, 200, 100)).toBeNull()
  })
})
