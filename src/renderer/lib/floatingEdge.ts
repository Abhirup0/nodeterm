// Pure geometry for the canvas's one edge type. An edge is drawn between the two points where the
// centre-to-centre line leaves each node's rectangle, so it always takes the short way round — the
// fixed-side handles it replaces sent an edge to a node placed left of (or above) its source on a
// loop across the whole canvas, with its label drifting into empty space.
import { Position } from '@xyflow/react'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface EdgeEnd {
  x: number
  y: number
  position: Position
}

/**
 * The point on `from`'s border where the line from its centre toward `toward` exits, and the side
 * it exits on. A degenerate rectangle (unmeasured) or a coincident centre answers deterministically
 * (its own point, `Right`) — never NaN, so a path is always drawable.
 */
export function borderExit(from: Rect, toward: { x: number; y: number }): EdgeEnd {
  const hw = from.width / 2
  const hh = from.height / 2
  const cx = from.x + hw
  const cy = from.y + hh
  if (!(hw > 0) || !(hh > 0)) return { x: from.x, y: from.y, position: Position.Right }
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx + hw, y: cy, position: Position.Right }
  // Compare the slopes against the corner: |dx|/hw vs |dy|/hh decides which side the line crosses.
  if (Math.abs(dx) * hh >= Math.abs(dy) * hw) {
    const sx = dx >= 0 ? 1 : -1
    return { x: cx + sx * hw, y: cy + dy * (hw / Math.abs(dx)), position: sx > 0 ? Position.Right : Position.Left }
  }
  const sy = dy >= 0 ? 1 : -1
  return { x: cx + dx * (hh / Math.abs(dy)), y: cy + sy * hh, position: sy > 0 ? Position.Bottom : Position.Top }
}

export interface FloatingParams {
  sx: number
  sy: number
  sourcePosition: Position
  tx: number
  ty: number
  targetPosition: Position
}

export function floatingEdgeParams(a: Rect, b: Rect): FloatingParams {
  const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
  const s = borderExit(a, centre(b))
  const t = borderExit(b, centre(a))
  return { sx: s.x, sy: s.y, sourcePosition: s.position, tx: t.x, ty: t.y, targetPosition: t.position }
}
