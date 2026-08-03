import type { Camera, Rect } from './camera'

/** A rectangle in DEVICE pixels with a BOTTOM-LEFT origin — GL's scissor convention, not the
 *  browser's. Deliberately not camera.ts's `Rect`: that one is world-space and top-left, and
 *  sharing the type is exactly how a Y-flip gets forgotten. */
export interface DeviceRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The occlusion plate's scissor rect: the plate's WORLD rect (`GridDrawParams.plateX/Y/W/H` — the
 * node body's full area, which is generally LARGER than the character matrix), projected through
 * the camera and clamped to the drawing buffer. Pure, so the four coordinate hops below are
 * testable without a GL context — which is the point of the extraction, since a Y-flip or a
 * missing `* dpr` is invisible in a code review and obvious in a unit test.
 *
 * Takes the rect itself rather than the whole `GridDrawParams`: the plate stopped being derived
 * from the grid geometry (it was `grid rect + padPx`, which is what left bands of raw canvas at
 * the bottom and right of every terminal), so there is nothing here that needs cols/rows/cellW.
 *
 * Returns null when the rect covers no pixel of the drawing buffer: the caller must SKIP the
 * clear entirely. A clamped-empty rect is not merely wasteful — a NEGATIVE scissor extent is a
 * GL_INVALID_VALUE, and clamping the origin to 0 without shrinking the extent would silently
 * move the rect's far edge.
 *
 * The hops, in order:
 *  1. world → screen (CSS px): `screen = world * zoom + pan`, exactly as the vertex shader does.
 *  2. CSS px → DEVICE px via `dpr` — the ratio captured at `resize`, never `devicePixelRatio`
 *     read at call time (they disagree the moment a window crosses monitors mid-frame).
 *  3. Y FLIP: GL's scissor origin is bottom-left while world/CSS Y grows downward, so the
 *     device y is measured from the buffer's BOTTOM: `deviceH - (top + height)`.
 *  4. Clamp to [0, deviceW] × [0, deviceH].
 */
export function plateRectDevice(
  plate: Rect,
  cam: Camera,
  dpr: number,
  deviceW: number,
  deviceH: number
): DeviceRect | null {
  // (1) world → screen (CSS px).
  const leftCss = plate.x * cam.zoom + cam.x
  const topCss = plate.y * cam.zoom + cam.y
  const wCss = plate.w * cam.zoom
  const hCss = plate.h * cam.zoom
  // (2) CSS px → DEVICE px.
  const left = Math.round(leftCss * dpr)
  const top = Math.round(topCss * dpr)
  const width = Math.round(wCss * dpr)
  const height = Math.round(hCss * dpr)
  // (3) Y FLIP.
  const bottom = deviceH - (top + height)
  // (4) Clamp.
  const x0 = Math.max(0, left)
  const y0 = Math.max(0, bottom)
  const x1 = Math.min(deviceW, left + width)
  const y1 = Math.min(deviceH, bottom + height)
  // `<=`, not `<`: a rect that only shares an edge with the viewport covers zero pixels.
  if (x1 <= x0 || y1 <= y0) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
