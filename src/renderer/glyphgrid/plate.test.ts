import { describe, expect, it } from 'vitest'
import type { Rect } from './camera'
import { plateRectDevice } from './plate'

/** A 40×40 world rect at the given origin — the shape a small terminal BODY has. */
const plate = (over: Partial<Rect> = {}): Rect => ({ x: 10, y: 10, w: 40, h: 40, ...over })

const CAM = { x: 0, y: 0, zoom: 1 }

describe('plateRectDevice', () => {
  it('flips Y against the drawing buffer height', () => {
    // Derived by hand. World rect (10,10)-(50,50) at zoom 1, pan 0 → the same in CSS px. At
    // dpr 1 that is device px too. GL's scissor origin is BOTTOM-left, so the rect's device y is
    // the distance from the buffer's BOTTOM to the rect's BOTTOM edge: 100 - 50 = 50.
    expect(plateRectDevice(plate(), CAM, 1, 200, 100)).toEqual({ x: 10, y: 50, w: 40, h: 40 })
  })

  it('scales into device pixels by dpr, not by devicePixelRatio at call time', () => {
    // Same world rect at dpr 2 against a 400×200 drawing buffer: every extent doubles and the
    // flip is taken against the DEVICE height (200 - (20 + 80) = 100), never the CSS one.
    expect(plateRectDevice(plate(), CAM, 2, 400, 200)).toEqual({ x: 20, y: 100, w: 80, h: 80 })
  })

  it('applies the camera: pan then zoom, exactly as the vertex shader does', () => {
    // screen = world * zoom + pan. Origin (10,10) at zoom 2 pan (5,5) → CSS (25,25), extent 80.
    // Flip: 200 - (25 + 80) = 95.
    expect(plateRectDevice(plate(), { x: 5, y: 5, zoom: 2 }, 1, 400, 200)).toEqual({
      x: 25,
      y: 95,
      w: 80,
      h: 80
    })
  })

  it('takes the rect it is GIVEN — it does not derive one from the grid geometry', () => {
    // The regression this signature exists to prevent. The plate is the node BODY, which is
    // larger than the character matrix in both axes (a body's size is not an exact cell multiple,
    // and xterm letterboxes the remainder); a plate re-derived from cols×cellW leaves exactly that
    // remainder showing raw canvas at the bottom and right — the reported bands.
    // Body (4,4) 52×54 while the matrix would be (10,10) 40×40. Flip: 100 - (4 + 54) = 42.
    expect(plateRectDevice({ x: 4, y: 4, w: 52, h: 54 }, CAM, 1, 200, 100)).toEqual({
      x: 4,
      y: 42,
      w: 52,
      h: 54
    })
  })

  it('clamps to the drawing buffer instead of returning a negative origin or extent', () => {
    // Origin (-10,-10): the rect hangs off the left and the top. A scissor rect may legally sit
    // outside the viewport, but pushing the origin to 0 without shrinking the extent would move
    // the far edge — and a NEGATIVE extent is a GL_INVALID_VALUE.
    // Visible CSS span: x 0..30, y 0..30 → device y from 100-30 = 70, height 30.
    expect(plateRectDevice(plate({ x: -10, y: -10 }), CAM, 1, 200, 100)).toEqual({
      x: 0,
      y: 70,
      w: 30,
      h: 30
    })
  })

  it('is null when the rect is entirely off-screen', () => {
    // Null, not a zero-area rect: the caller must SKIP the clear, and a {w:0,h:0} scissor would
    // still cost the state changes around it.
    expect(plateRectDevice(plate({ x: 500 }), CAM, 1, 200, 100)).toBeNull()
    expect(plateRectDevice(plate({ y: -500 }), CAM, 1, 200, 100)).toBeNull()
  })

  it('is null when the rect touches an edge without covering a pixel', () => {
    // A 40-wide rect at x=-40 ends exactly at x=0: it shares an edge with the viewport and
    // covers zero pixels, so it must be null rather than a zero-width scissor.
    expect(plateRectDevice(plate({ x: -40 }), CAM, 1, 200, 100)).toBeNull()
  })

  it('is null for a zero-extent plate (an unmeasured body), never a degenerate scissor', () => {
    // `bodyPlateRect` collapses a non-finite/negative client size to 0 rather than propagating a
    // NaN. That reaches here as a zero-area rect, and the contract is the same as off-screen:
    // skip the clear.
    expect(plateRectDevice(plate({ w: 0 }), CAM, 1, 200, 100)).toBeNull()
    expect(plateRectDevice(plate({ h: 0 }), CAM, 1, 200, 100)).toBeNull()
  })
})
