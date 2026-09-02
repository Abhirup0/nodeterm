// Pure geometry for the canvas's one edge type. An edge leaves each node from the MIDPOINT of the
// side its centre-to-centre line crosses, so it always takes the short way round — the fixed-side
// handles it replaces sent an edge to a node placed left of (or above) its source on a loop across
// the whole canvas — and every edge using a side leaves from ONE point, so arrows converge instead
// of fanning out along the border (measured on a hub node with a dozen ropes: entries were spread
// across the whole top edge). Context links are restricted to the left/right sides: those are where
// the drag handles (`link-out` / `link-in`) sit, and the edge should meet the dot the user dragged.
import { Position } from '@xyflow/react'

/** Which sides an edge may leave from: every side, or only left/right (the bridge handles). */
export type AnchorSides = 'all' | 'horizontal'

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
 * The MIDPOINT of the side of `from` that the line from its centre toward `toward` crosses, and
 * that side. `sides: 'horizontal'` restricts the choice to left/right (a target above or below
 * still leaves from a side, picked by the sign of dx). A degenerate rectangle (unmeasured) or a
 * coincident centre answers deterministically (its own point, `Right`) — never NaN, so a path is
 * always drawable.
 */
export function borderExit(
  from: Rect,
  toward: { x: number; y: number },
  sides: AnchorSides = 'all'
): EdgeEnd {
  const hw = from.width / 2
  const hh = from.height / 2
  const cx = from.x + hw
  const cy = from.y + hh
  if (!(hw > 0) || !(hh > 0)) return { x: from.x, y: from.y, position: Position.Right }
  const dx = toward.x - cx
  const dy = toward.y - cy
  const right = { x: cx + hw, y: cy, position: Position.Right }
  const left = { x: cx - hw, y: cy, position: Position.Left }
  if (dx === 0 && dy === 0) return right
  // Compare the slopes against the corner: |dx|/hw vs |dy|/hh decides which side the line crosses.
  if (sides === 'horizontal' || Math.abs(dx) * hh >= Math.abs(dy) * hw) return dx >= 0 ? right : left
  return dy >= 0 ? { x: cx, y: cy + hh, position: Position.Bottom } : { x: cx, y: cy - hh, position: Position.Top }
}

export interface FloatingParams {
  sx: number
  sy: number
  sourcePosition: Position
  tx: number
  ty: number
  targetPosition: Position
}

export function floatingEdgeParams(a: Rect, b: Rect, sides: AnchorSides = 'all'): FloatingParams {
  const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
  const s = borderExit(a, centre(b), sides)
  const t = borderExit(b, centre(a), sides)
  return { sx: s.x, sy: s.y, sourcePosition: s.position, tx: t.x, ty: t.y, targetPosition: t.position }
}
