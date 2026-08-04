import { describe, expect, it } from 'vitest'
import type { Rect } from './camera'
import { plateRadiusDevice, plateRectDevice, plateShapeDevice } from './plate'

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

describe('plateShapeDevice', () => {
  it('agrees with plateRectDevice while the plate is fully on screen', () => {
    // The two only differ at the viewport edge, so the common case pins them together: a rect
    // wholly inside the buffer is its own visible part, and the rounded shape must be defined
    // against exactly the same pixels the clipped draw covers.
    expect(plateShapeDevice(plate(), CAM, 1, 100)).toEqual({ x: 10, y: 50, w: 40, h: 40 })
  })

  it('does NOT clamp — the corner must stay where the node is, not at the viewport edge', () => {
    // The whole reason this exists next to plateRectDevice. Origin (-10,-10) hangs off the left
    // and the top; the CLAMPED rect starts at x 0, and rounding a corner against that would draw
    // the node's rounded corner in the MIDDLE of the screen, ten pixels in from an edge the node
    // does not have there. Flip: 100 - (-10 + 40) = 70.
    expect(plateShapeDevice(plate({ x: -10, y: -10 }), CAM, 1, 100)).toEqual({
      x: -10,
      y: 70,
      w: 40,
      h: 40
    })
  })

  it('answers a rect even when the plate covers no pixel — visibility is the other function’s job', () => {
    // Never null: this is a SHAPE, and the caller has already decided (via plateRectDevice) that
    // there is something to draw. Two responsibilities, two answers.
    expect(plateShapeDevice(plate({ x: 500 }), CAM, 1, 100)).toEqual({
      x: 500,
      y: 50,
      w: 40,
      h: 40
    })
  })

  it('takes the same camera/dpr hops as the scissor rect', () => {
    // dpr 2 against a 200-tall buffer: extents double and the flip is taken against the DEVICE
    // height — 200 - (20 + 80) = 100, exactly as plateRectDevice's own dpr test derives it.
    expect(plateShapeDevice(plate(), CAM, 2, 200)).toEqual({ x: 20, y: 100, w: 80, h: 80 })
  })
})

describe('plateRadiusDevice', () => {
  it('scales the radius with zoom and dpr', () => {
    // The radius is authored in WORLD units (CSS px at zoom 1) because that is where the node's
    // stylesheet defines it; on screen it has to follow the same `zoom * dpr` every extent does,
    // or a zoomed-in terminal keeps a corner a quarter of its apparent size.
    expect(plateRadiusDevice(10, 2, { w: 200, h: 100 })).toBe(20)
  })

  it('never exceeds half the shorter side', () => {
    // A 10px radius on a 12px-tall plate would round the rect into a stadium and then INVERT the
    // SDF (the inner box's half-extent goes negative), which paints a corner-shaped hole instead
    // of a corner. Clamping at half the shorter side is what keeps a COLLAPSING node — a body
    // dragged down to nothing — from flickering through that inversion.
    expect(plateRadiusDevice(10, 1, { w: 200, h: 12 })).toBe(6)
    expect(plateRadiusDevice(10, 1, { w: 8, h: 200 })).toBe(4)
  })

  it('is 0 for a square plate — every caller that asks for no radius keeps today’s rectangle', () => {
    expect(plateRadiusDevice(0, 2, { w: 200, h: 100 })).toBe(0)
  })

  it('is 0 for a degenerate radius, scale or rect rather than a NaN in a uniform', () => {
    // These reach the shader as a uniform the corner SDF subtracts, so a NaN here would not
    // round a corner — it would make every fragment of the plate fail the coverage test and the
    // terminal's whole background disappear. Guarded, like `cursorThicknessWorld`.
    expect(plateRadiusDevice(-4, 1, { w: 200, h: 100 })).toBe(0)
    expect(plateRadiusDevice(Number.NaN, 1, { w: 200, h: 100 })).toBe(0)
    expect(plateRadiusDevice(10, 0, { w: 200, h: 100 })).toBe(0)
    expect(plateRadiusDevice(10, 1, { w: 0, h: 100 })).toBe(0)
    expect(plateRadiusDevice(10, 1, { w: 200, h: -5 })).toBe(0)
  })
})
