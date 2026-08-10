/** A canvas viewport: React Flow's `{ x, y, zoom }`, in screen px and a scale factor. */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

/**
 * The viewport that puts the canvas back at 100% without moving what the user is looking at.
 *
 * The anchor is the viewport CENTRE, not the origin: zooming about the corner throws the user's
 * work off screen, which makes a reset feel like a jump rather than a correction.
 *
 * Zoom 1 matters beyond ergonomics — it is the only ratio at which the shared renderer samples the
 * glyph atlas texel-for-texel, so "am I actually at 1?" is a question both users and bug reports
 * need to be able to settle. Until this existed the only way was to read the viewport transform in
 * DevTools, which is how the 2026-08-09 crispness report was finally pinned (at 0.976).
 *
 * A zoom that is already 1, or one that is not a usable number, returns the viewport UNCHANGED —
 * the command is then a no-op rather than a nudge.
 */
export function viewportAtZoom1(current: Viewport, centre: { x: number; y: number }): Viewport {
  const { x, y, zoom } = current
  if (!Number.isFinite(zoom) || zoom <= 0 || zoom === 1) return current
  // The world point under the screen centre, held fixed across the change.
  const worldX = (centre.x - x) / zoom
  const worldY = (centre.y - y) / zoom
  return { x: centre.x - worldX, y: centre.y - worldY, zoom: 1 }
}
