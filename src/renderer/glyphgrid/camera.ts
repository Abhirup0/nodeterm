/** Pan/zoom camera, IDENTICAL in convention to React Flow's Viewport: x/y are the pan offsets
 *  in screen pixels, zoom is the scale. screen = world * zoom + pan. Pure module. */
export interface Camera {
  x: number
  y: number
  zoom: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function worldToScreen(wx: number, wy: number, cam: Camera): { x: number; y: number } {
  return { x: wx * cam.zoom + cam.x, y: wy * cam.zoom + cam.y }
}

export function screenToWorld(sx: number, sy: number, cam: Camera): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.zoom, y: (sy - cam.y) / cam.zoom }
}

/** The world-space rectangle the screen viewport currently shows — the culling input. */
export function visibleWorldRect(cam: Camera, viewW: number, viewH: number): Rect {
  const tl = screenToWorld(0, 0, cam)
  return { x: tl.x, y: tl.y, w: viewW / cam.zoom, h: viewH / cam.zoom }
}

/**
 * Snap a camera's PAN to whole DEVICE pixels. The zoom is returned untouched.
 *
 * The glyph atlas is sampled with NEAREST magnification, so where a cell's quad lands within the
 * device-pixel grid decides which texel each screen pixel takes. A pan carrying a sub-device-pixel
 * fraction re-rolls that choice EVERY frame: during a drag the same glyph is resampled slightly
 * differently sixty times a second, and the text ripples behind node chrome that is moving
 * rigidly — the "our text waves while the node doesn't" report. Rounding shifts the whole world by
 * at most half a device pixel (invisible, and constant while the camera is still) and locks the
 * texel alignment for the duration of the pan.
 *
 * The ZOOM is deliberately NOT snapped: it is a scale, not an offset. Quantizing it would step
 * visibly while zooming and would still leave the cell PITCH fractional, so it buys nothing.
 *
 * A non-finite or non-positive dpr (a mocked GL surface, a browser mid-monitor-switch) means
 * "device pixels are unknown here" — pass the camera through rather than round to NaN.
 */
export function snapPanToDevicePx(cam: Camera, dpr: number): Camera {
  if (!Number.isFinite(dpr) || dpr <= 0) return { x: cam.x, y: cam.y, zoom: cam.zoom }
  return {
    x: Math.round(cam.x * dpr) / dpr,
    y: Math.round(cam.y * dpr) / dpr,
    zoom: cam.zoom
  }
}

/** Strict overlap (shared edge does not count — an edge-touching grid draws zero pixels). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
