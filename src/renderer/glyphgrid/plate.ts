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
 * The plate's WHOLE device rect — where the node BODY is, whether or not it is on screen.
 *
 * This is the rect the plate's SHAPE is defined against: the rounded-corner SDF measures a
 * fragment's distance from these four edges, so it has to be the node's real rect. Its clamped
 * sibling below answers a different question (which pixels are worth drawing), and the two must
 * not be conflated — a shape measured against the CLAMPED rect would put a rounded corner at the
 * VIEWPORT edge, i.e. draw the node's corner ten pixels into open canvas on a node that is merely
 * half scrolled off. Never null for the same reason: a rect that covers no pixel still has a
 * shape, and whether to draw at all is `plateRectDevice`'s answer.
 *
 * The hops, in order:
 *  1. world → screen (CSS px): `screen = world * zoom + pan`, exactly as the vertex shader does.
 *  2. CSS px → DEVICE px via `dpr` — the ratio captured at `resize`, never `devicePixelRatio`
 *     read at call time (they disagree the moment a window crosses monitors mid-frame).
 *  3. Y FLIP: GL's window origin is bottom-left (both `gl_FragCoord` and the scissor) while
 *     world/CSS Y grows downward, so the device y is measured from the buffer's BOTTOM:
 *     `deviceH - (top + height)`.
 *
 * ROUNDED, not truncated, on every hop — and that rounding is load-bearing beyond tidiness: it
 * puts the plate's straight edges exactly on device-pixel boundaries, which is what lets the
 * fragment shader's one-pixel coverage window leave a straight edge at full alpha (see
 * PLATE_FRAG). A fractional edge would feather the body's own border by half a pixel.
 */
export function plateShapeDevice(
  plate: Rect,
  cam: Camera,
  dpr: number,
  deviceH: number
): DeviceRect {
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
  return { x: left, y: deviceH - (top + height), w: width, h: height }
}

/**
 * The occlusion plate's VISIBLE device rect: `plateShapeDevice` clamped to the drawing buffer.
 * Pure, so the coordinate hops are testable without a GL context — which is the point of the
 * extraction, since a Y-flip or a missing `* dpr` is invisible in a code review and obvious in a
 * unit test.
 *
 * Takes the rect itself rather than the whole `GridDrawParams`: the plate stopped being derived
 * from the grid geometry (it was `grid rect + padPx`, which is what left bands of raw canvas at
 * the bottom and right of every terminal), so there is nothing here that needs cols/rows/cellW.
 *
 * Returns null when the rect covers no pixel of the drawing buffer: the caller must SKIP the
 * plate entirely. A clamped-empty rect is not merely wasteful — it was a GL_INVALID_VALUE while
 * this drove a `scissor`, and it is a degenerate quad now that it bounds a DRAW; either way,
 * clamping the origin to 0 without shrinking the extent would silently move the rect's far edge.
 */
export function plateRectDevice(
  plate: Rect,
  cam: Camera,
  dpr: number,
  deviceW: number,
  deviceH: number
): DeviceRect | null {
  const r = plateShapeDevice(plate, cam, dpr, deviceH)
  const x0 = Math.max(0, r.x)
  const y0 = Math.max(0, r.y)
  const x1 = Math.min(deviceW, r.x + r.w)
  const y1 = Math.min(deviceH, r.y + r.h)
  // `<=`, not `<`: a rect that only shares an edge with the viewport covers zero pixels.
  if (x1 <= x0 || y1 <= y0) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * The plate's corner radius in DEVICE pixels, from the WORLD-unit radius the node's stylesheet
 * defines and the frame's `zoom * dpr`.
 *
 * CLAMPED AT HALF THE SHORTER SIDE, which is the whole reason this is a function rather than a
 * multiplication at the call site. The rounded-rect SDF works by shrinking the rect by the radius
 * on every side and measuring distance to that inner box; a radius past half the shorter side
 * makes the inner box's half-extent NEGATIVE, and the field it produces is no longer the
 * rectangle's — it paints a corner-shaped hole rather than a corner.
 *
 * THE CLAMP IS DEFENSIVE, AND IS NOT REACHABLE THROUGH THE UI — do not go hunting for the case.
 * A node's body bottoms out around ~120 world px (`NodeResizer minHeight={160}` in `TerminalNode`,
 * and `terminalNodeSize()`'s own floor), while the clamp only engages below roughly twice the
 * radius, ~18 world px. Zoom cannot reach it either: the caller passes `zoom * dpr` as the scale
 * AND measures the shape at that same scale, so the radius-to-side ratio is zoom-invariant by
 * construction. It is kept because the guarantee is a stylesheet value and two layout constants
 * away from being false, and the failure it prevents is the terminal's background disappearing.
 *
 * Degenerate inputs answer 0 — a square plate, i.e. exactly the pre-Phase-2 rectangle — rather
 * than NaN or Infinity. The result is a uniform the SDF SUBTRACTS, so a NaN would not merely
 * unround the corner: every fragment's coverage test would fail and the terminal's background
 * would vanish. Same discipline as `cursorThicknessWorld`, and for the same class of reason.
 *
 * Takes `{w, h}` rather than a whole `DeviceRect` so the caller cannot accidentally pass the
 * CLAMPED rect's extent: the radius belongs to the node's real size, and clamping it against a
 * half-scrolled-off rect would shrink the corner as the node leaves the screen.
 */
export function plateRadiusDevice(
  radiusWorld: number,
  dprZoom: number,
  size: { w: number; h: number }
): number {
  if (!(radiusWorld > 0) || !(dprZoom > 0) || !(size.w > 0) || !(size.h > 0)) return 0
  return Math.min(radiusWorld * dprZoom, size.w / 2, size.h / 2)
}
