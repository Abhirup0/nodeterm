import { describe, expect, it } from 'vitest'
import {
  cursorOverlays,
  cursorThicknessWorld,
  MAX_CURSOR_RECTS,
  resolveCursorShape,
  type CursorShape
} from './cursor'

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

  it('keeps a BAR at one thickness on a wide glyph — only the span grows, not the mark', () => {
    // The bar marks the INSERTION POINT, which is the left edge of the cell whatever the glyph
    // there is; widening it with the cell would draw a half-block on every CJK character.
    expect(cursorOverlays('bar', 2, 2, 10, 20)).toEqual([{ x: 0, y: 0, w: 2, h: 20 }])
  })

  it('outlines both columns of a wide glyph, with the right edge on the FAR column', () => {
    expect(cursorOverlays('outline', 2, 1, 10, 20)).toEqual([
      { x: 0, y: 0, w: 20, h: 1 },
      { x: 0, y: 19, w: 20, h: 1 },
      { x: 0, y: 1, w: 1, h: 18 },
      { x: 19, y: 1, w: 1, h: 18 }
    ])
  })

  it('draws nothing at zero (or negative) thickness rather than empty rects', () => {
    // A rect of no area is a draw call that paints nothing; the caller skips the whole pass on an
    // empty list, so answering [] is what makes a degenerate cell cost zero GL calls.
    expect(cursorOverlays('bar', 1, 0, 10, 20)).toEqual([])
    expect(cursorOverlays('outline', 1, -3, 10, 20)).toEqual([])
  })

  it('clamps a thickness larger than the cell instead of emitting negative rects', () => {
    // A hairline is a fraction of a cell in every real configuration, but the thickness is derived
    // from the camera (see cursorThicknessWorld) and a deeply zoomed-out cell is smaller than one
    // device pixel — where an unclamped underline would sit at a NEGATIVE y and an outline's
    // verticals would have negative height, which draws either nothing or a stripe across the row.
    expect(cursorOverlays('underline', 1, 50, 10, 20)).toEqual([{ x: 0, y: 0, w: 10, h: 20 }])
    expect(cursorOverlays('bar', 1, 50, 10, 20)).toEqual([{ x: 0, y: 0, w: 10, h: 20 }])
    // Half the cell each way is the most an outline can take before the two horizontals meet.
    expect(cursorOverlays('outline', 1, 50, 10, 20)).toEqual([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 0, y: 10, w: 10, h: 10 }
    ])
  })
})

/** The overlay pass sizes a UNIFORM ARRAY from `MAX_CURSOR_RECTS` and truncates anything longer, so
 *  a shape that ever produced more rects than that would silently lose an edge on screen with
 *  nothing failing anywhere. Pinned here, over every shape and both widths. */
describe('MAX_CURSOR_RECTS', () => {
  it('bounds what any shape can produce', () => {
    const shapes: CursorShape[] = ['block', 'bar', 'underline', 'outline', 'none']
    for (const shape of shapes) {
      for (const widthCells of [1, 2]) {
        for (const t of [0.5, 1, 2, 7, 40]) {
          expect(cursorOverlays(shape, widthCells, t, 10, 20).length).toBeLessThanOrEqual(
            MAX_CURSOR_RECTS
          )
        }
      }
    }
  })
})

/** The shape a terminal's cursor takes, from xterm's two options and the focus flag.
 *
 *  The pair is what makes this worth a function: xterm has a style for a FOCUSED terminal and a
 *  separate one for a blurred one, and the blurred default — `outline` — is precisely the hollow box
 *  the shared renderer could not draw. */
describe('resolveCursorShape', () => {
  it('maps the focused styles one-to-one', () => {
    expect(resolveCursorShape(true, 'block', 'outline')).toBe('block')
    expect(resolveCursorShape(true, 'bar', 'outline')).toBe('bar')
    expect(resolveCursorShape(true, 'underline', 'outline')).toBe('underline')
  })

  it('reads the INACTIVE style when the terminal is blurred', () => {
    expect(resolveCursorShape(false, 'block', 'outline')).toBe('outline')
    expect(resolveCursorShape(false, 'block', 'none')).toBe('none')
    expect(resolveCursorShape(false, 'block', 'bar')).toBe('bar')
    expect(resolveCursorShape(false, 'bar', 'underline')).toBe('underline')
    expect(resolveCursorShape(false, 'bar', 'block')).toBe('block')
  })

  it("falls back to xterm's OWN defaults when an option is missing", () => {
    // Which is the case this whole task exists for: `outline` is xterm's default
    // `cursorInactiveStyle`, so an app that never sets the option — nodeterm's own default —
    // wants a hollow box on every blurred terminal.
    expect(resolveCursorShape(true, undefined, undefined)).toBe('block')
    expect(resolveCursorShape(false, undefined, undefined)).toBe('outline')
  })

  it('treats an unknown option as the default for that focus state, never as no cursor', () => {
    // The strings come from `term.options`, i.e. from settings on disk. A value this renderer does
    // not know must degrade to the shape xterm would have drawn, not to an invisible cursor.
    expect(resolveCursorShape(true, 'wobble', 'outline')).toBe('block')
    expect(resolveCursorShape(false, 'block', 'wobble')).toBe('outline')
  })

  it('never answers `outline` for a FOCUSED terminal', () => {
    // xterm's `cursorStyle` has no outline member; accepting one here would let a settings typo
    // put every focused terminal on a hollow cursor.
    expect(resolveCursorShape(true, 'outline', 'outline')).toBe('block')
    expect(resolveCursorShape(true, 'none', 'outline')).toBe('block')
  })
})

/** The hairline's world-unit thickness, derived from the camera.
 *
 *  World units are CSS px at zoom 1, and the mark has to read as a HAIRLINE at every zoom: one CSS
 *  px, except that it may never fall below one DEVICE px, which is where it would start to
 *  disappear into the gaps between sampled pixels. */
describe('cursorThicknessWorld', () => {
  it('is one CSS pixel at zoom 1', () => {
    expect(cursorThicknessWorld(1, 1)).toBe(1)
    expect(cursorThicknessWorld(1, 2)).toBe(1)
  })

  it('grows in WORLD units as the camera zooms out, so the mark stays one device pixel', () => {
    // zoom 0.25 on a dpr-2 display: one device px is 2 world units, and a 1-unit line would be
    // half a device pixel — a cursor that fades out as the user zooms away from it.
    expect(cursorThicknessWorld(0.25, 2)).toBe(2)
    expect(cursorThicknessWorld(0.1, 1)).toBe(10)
  })

  it('does not SHRINK when zoomed in — the mark stays a CSS pixel, like every other renderer', () => {
    expect(cursorThicknessWorld(4, 2)).toBe(1)
  })

  it('survives a degenerate camera rather than answering NaN or 0', () => {
    // A zoom or dpr of 0 reaches here only from a half-initialized camera, and a NaN rect poisons
    // the whole draw call it lands in.
    expect(cursorThicknessWorld(0, 2)).toBe(1)
    expect(cursorThicknessWorld(1, 0)).toBe(1)
    expect(cursorThicknessWorld(Number.NaN, Number.NaN)).toBe(1)
  })
})
