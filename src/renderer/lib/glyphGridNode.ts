/**
 * Pure geometry/colour helpers for the glyphgrid grid a TerminalNode registers.
 *
 * They live outside `nodes/TerminalNode.tsx` for one reason: that file is 2200 lines of DOM,
 * xterm and pty lifecycle that no unit test can mount, and the three numbers below (where the
 * grid's first cell sits in world space, how far the opaque plate may spill, what colour it is
 * cleared to) are exactly the parts where an off-by-one is invisible in review and glaring on
 * screen. Everything here takes plain numbers so the contract can be pinned; the DOM reads that
 * FEED them stay in the node, where they belong.
 */

import { packColor } from '../glyphgrid/cells'

export interface Vec2 {
  x: number
  y: number
}

/** CSS insets, in world units (canvas CSS px at zoom 1). */
export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * World position of the grid's TOP-LEFT CELL.
 *
 * `nodePos` is React Flow's absolute node position (`positionAbsoluteX/Y` — already resolved
 * through a group parent's chain) and `bodyOffset` is the terminal screen's layout offset inside
 * that node, accumulated up the `offsetParent` chain. Both are LAYOUT coordinates: the canvas
 * transform scales pixels, it does not change offsets, so this sum is zoom-independent and the
 * engine's camera does the rest.
 *
 * Trivial arithmetic, deliberately named: the failure it guards against is someone later feeding
 * the SCREEN rect (a `getBoundingClientRect`, which is zoom- and scroll-dependent) into a
 * world-space API and watching every terminal's text drift away from its node as you zoom.
 */
export function bodyWorldRect(nodePos: Vec2, bodyOffset: Vec2): Vec2 {
  return { x: nodePos.x + bodyOffset.x, y: nodePos.y + bodyOffset.y }
}

/**
 * The engine's plate padding — ONE scalar, expanded on all four sides (see `GridSpec.padPx`) —
 * resolved from the terminal host's CSS padding, which is NOT symmetric (`.term-node__xterm` is
 * `4px 2px 2px 6px`).
 *
 * The MINIMUM is the only safe reduction. The plate is an opaque scissored clear: too small and
 * the node's own opaque body background covers the difference (invisible), too large and it
 * paints over whatever sits beside the node — chrome, a neighbour, the canvas background — which
 * is a visible artefact nothing else corrects. Under-covering is free; over-covering is a bug.
 *
 * Negative/NaN inputs (a computed style that failed to parse) collapse to 0 rather than
 * propagating into the engine's rect math.
 */
export function platePadPx(pad: Insets): number {
  const sides = [pad.top, pad.right, pad.bottom, pad.left]
  let min = Infinity
  for (const v of sides) {
    if (!Number.isFinite(v)) return 0
    if (v < min) min = v
  }
  return min > 0 ? min : 0
}

/** Fallback background — the colour `TerminalNode` builds every xterm with. Used when the theme
 *  carries no background, or one this parser does not understand. */
export const DEFAULT_TERMINAL_BG = '#1e1e1e'

/**
 * Pack an xterm theme background into an OPAQUE engine lane.
 *
 * Alpha is forced to 0xff for the same reason `glyphgrid-attach`'s `lane()` forces it: the plate
 * is what occludes the grid underneath it, and a translucent clear colour would punch a hole
 * through one terminal into another.
 *
 * Only the `#rgb` / `#rrggbb` forms xterm themes are written in are parsed. Anything else — a
 * named colour, `rgb()`, `#rrggbbaa` — falls back to the default rather than guessing: a wrong
 * background is a wrong terminal, and this is not a CSS colour engine.
 */
export function packThemeBg(color: string | undefined): number {
  const rgb = parseHexRgb(color) ?? parseHexRgb(DEFAULT_TERMINAL_BG)!
  return packColor(rgb.r, rgb.g, rgb.b, 0xff)
}

function parseHexRgb(color: string | undefined): { r: number; g: number; b: number } | null {
  if (typeof color !== 'string') return null
  const hex = color.trim()
  if (hex.length !== 4 && hex.length !== 7) return null
  if (hex[0] !== '#') return null
  const body = hex.slice(1)
  if (!/^[0-9a-fA-F]+$/.test(body)) return null
  if (body.length === 3) {
    const r = parseInt(body[0] + body[0], 16)
    const g = parseInt(body[1] + body[1], 16)
    const b = parseInt(body[2] + body[2], 16)
    return { r, g, b }
  }
  return {
    r: parseInt(body.slice(0, 2), 16),
    g: parseInt(body.slice(2, 4), 16),
    b: parseInt(body.slice(4, 6), 16)
  }
}

/**
 * Validate a cell size before it becomes a grid's fixed geometry.
 *
 * A grid's `cellW/cellH` cannot be changed after `register` (the shared context is torn down and
 * every node re-registers instead), so a zero or NaN measured off a not-yet-laid-out terminal
 * would freeze THAT terminal at a broken geometry for the life of the session. Null means "don't
 * register" — the node stays on xterm's own renderer, which is always a correct outcome.
 */
export function validCellSize(width: number, height: number): { cellW: number; cellH: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width <= 0 || height <= 0) return null
  return { cellW: width, cellH: height }
}
