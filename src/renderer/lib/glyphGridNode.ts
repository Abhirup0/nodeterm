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

/** A world-space rectangle, top-left origin — the engine's plate rect (`GridSpec.plateX/Y/W/H`). */
export interface WorldRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The opaque plate's world rect: the terminal BODY's full area.
 *
 * A glyph-attached terminal is a transparent WINDOW onto the shared canvas
 * (`.term-node--glyphgrid` drops the background from the node root and its body), so the plate IS
 * the terminal's background — every square of body the plate does not cover shows raw canvas
 * through the node. The GRID cannot supply that rect: a body's width/height are not exact cell
 * multiples, so xterm letterboxes the remainder, and the plate is therefore sized to the body box
 * rather than derived from cols×cellW.
 *
 * Pure numbers in, so it does not care WHICH element the caller measured — but the caller's choice
 * is load-bearing and is documented at ONE place: `TerminalNode`'s `measurePlateRect` measures the
 * HOST (`.term-node__xterm`), which equals the body's box only while the host is `inset: 0` inside
 * a padding-less, border-less `.term-node__body`. If either changes, the caller must measure
 * `.term-node__body` instead or the plate silently under-covers again.
 *
 * This replaced a `padPx` scalar taken from the host's asymmetric CSS padding (`4px 2px 2px 6px`
 * as it stood then), reduced to its 6px maximum. That covered the left/top insets and nothing
 * else, which is exactly why bands showed at the BOTTOM and RIGHT — the fit slack there routinely
 * exceeds 6px, and a
 * letterboxed node's bands are tens of pixels. The padding does not need reading at all now: it
 * lies INSIDE the measured box (`clientWidth/Height` include padding), covered on all four sides.
 *
 * `nodePos` + `bodyOffset` is the same LAYOUT sum `bodyWorldRect` does (zoom-independent — the
 * canvas transform scales pixels, not offsets). Non-finite or negative extents (an element that
 * is not laid out yet) collapse to 0 rather than propagating a NaN into the engine's rect math and
 * from there into a GL scissor.
 */
export function bodyPlateRect(
  nodePos: Vec2,
  bodyOffset: Vec2,
  bodyW: number,
  bodyH: number
): WorldRect {
  const origin = bodyWorldRect(nodePos, bodyOffset)
  return { x: origin.x, y: origin.y, w: extent(bodyW), h: extent(bodyH) }
}

function extent(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0
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
