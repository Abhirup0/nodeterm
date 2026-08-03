/**
 * GEOMETRIC glyphs for the box-drawing and block-element ranges.
 *
 * Why this exists at all: the shared rasterizer draws every code point with `fillText`, and a font
 * does not guarantee that its box/block glyphs fill the whole cell. Most monospace faces draw
 * U+2500 ─ a pixel or two short of the advance width, which is invisible in a word processor and
 * catastrophic in a terminal — a horizontal rule made of 60 of them shows 60 hairline GAPS, one at
 * every cell boundary. The block elements are worse: ▀▄█▌▐ and the eighth/quadrant family are
 * expected to tile EXACTLY, and a face whose ink is inset by the tiniest amount turns a piece of
 * block art into a lattice of dark seams.
 *
 * This is exactly why xterm's own renderers ship `CustomGlyphs.ts` (both the canvas addon and the
 * WebglAddon, `customGlyphs: true` by default): for these two ranges they stop trusting the font
 * and DRAW the shapes. We do the same, one step earlier — into the atlas instead of onto the
 * screen — so the geometry is rasterized once per code point and every grid samples it.
 *
 * The module is deliberately PURE: it returns rectangles, and knows nothing about a canvas, a
 * context or the atlas. `raster.ts` fills them; everything here is unit-testable arithmetic.
 *
 * ## The FULL-CELL invariant
 *
 * Every arm and every block edge that reaches a cell boundary is emitted at the EXACT boundary —
 * `x === 0` / `x + w === cellW` — never at a rounded approximation of it. Device cells are
 * fractional in general (xterm's `device.cell.width` is `charWidth * dpr`), so rounding the outer
 * edge of a full-width line to whole pixels is precisely how you re-introduce the gap this module
 * exists to remove. Only INTERIOR edges are snapped to whole device pixels (`snapX`/`snapY`),
 * which is what keeps a 1px line from being smeared across two columns of texels by antialiasing.
 *
 * ## v1 approximations (deliberate, documented)
 *
 * - **Rounded corners are drawn SQUARE.** U+256D–U+2570 (╭╮╯╰) use their sharp counterparts' arm
 *   table. A rect-only op list cannot express an arc; the alternative was to leave them to
 *   `fillText`, which would make a rounded box's corners the only part of the frame with gaps.
 * - **Diagonals fall back to the font.** U+2571–U+2573 (╱╲╳) are not axis-aligned and return
 *   `null`, so `fillText` draws them as before. They do not tile, so the gap problem does not
 *   apply to them.
 * - **Double-line junctions are drawn as rails, not as nested corners.** A double arm is two
 *   parallel light rails; where two double arms meet, each rail stops at the near or the far
 *   perpendicular rail (see `pushDoubleArm`). This is exact for the corners (╔╗╚╝) and the plain
 *   crossings, and slightly over-draws the tees (╠╣╦╩ keep the crossing rail continuous where the
 *   real glyph breaks it). Every case connects edge-to-edge, which is the property that matters.
 * - **Heavy/light is a thickness distinction only** — heavy is exactly twice light, which is what
 *   xterm does too.
 */

/** One axis-aligned fill, in CELL-LOCAL device pixels. `alpha` is the shade level (the shade
 *  blocks ░▒▓); absent means fully opaque. Rects only — see the module comment. */
export interface PaintOp {
  x: number
  y: number
  w: number
  h: number
  alpha?: number
}

// ---------------------------------------------------------------------------------------------
// Box drawing — the arm table
// ---------------------------------------------------------------------------------------------

/**
 * One entry per code point in U+2500–U+257F, as the four ARMS in clock order **U R D L**, each
 * `0` none / `1` light / `2` heavy / `3` double. An empty string means "not described by arms":
 * the dashed variants (handled by `DASHED` below) and the diagonals (font fallback).
 *
 * Reading a row: `'0110'` is U=0 R=1 D=1 L=0 — a light arm to the right and a light arm down,
 * i.e. ┌. The whole geometry of the range falls out of this table plus `pushArm`, which is why
 * it is transcribed in full rather than special-cased per character.
 */
const ARMS: readonly string[] = [
  // 0x2500 ─ ━ │ ┃, then the light/heavy triple- and quadruple-dash variants (DASHED), then ┌┍┎┏
  '0101', '0202', '1010', '2020', '', '', '', '',
  '', '', '', '', '0110', '0210', '0120', '0220',
  // 0x2510 ┐┑┒┓ └┕┖┗ ┘┙┚┛ ├┝┞┟
  '0011', '0012', '0021', '0022', '1100', '1200', '2100', '2200',
  '1001', '1002', '2001', '2002', '1110', '1210', '2110', '1120',
  // 0x2520 ┠┡┢┣ ┤┥┦┧ ┨┩┪┫ ┬┭┮┯
  '2120', '2210', '1220', '2220', '1011', '1012', '2011', '1021',
  '2021', '2012', '1022', '2022', '0111', '0112', '0211', '0212',
  // 0x2530 ┰┱┲┳ ┴┵┶┷ ┸┹┺┻ ┼┽┾┿
  '0121', '0122', '0221', '0222', '1101', '1102', '1201', '1202',
  '2101', '2102', '2201', '2202', '1111', '1112', '1211', '1212',
  // 0x2540 ╀╁╂╃ ╄╅╆╇ ╈╉╊╋, then the light/heavy double-dash variants (DASHED)
  '2111', '1121', '2121', '2112', '2211', '1122', '1221', '2212',
  '1222', '2122', '2221', '2222', '', '', '', '',
  // 0x2550 ═║ ╒╓╔ ╕╖╗ ╘╙╚ ╛╜╝ ╞╟
  '0303', '3030', '0310', '0130', '0330', '0013', '0031', '0033',
  '1300', '3100', '3300', '1003', '3001', '3003', '1310', '3130',
  // 0x2560 ╠╡╢╣ ╤╥╦ ╧╨╩ ╪╫╬, then the arcs ╭╮╯ (square in v1)
  '3330', '1013', '3031', '3033', '0313', '0131', '0333', '1303',
  '3101', '3303', '1313', '3131', '3333', '0110', '0011', '1001',
  // 0x2570 ╰, the diagonals ╱╲╳ (font fallback), then the stubs ╴╵╶╷ ╸╹╺╻ ╼╽╾╿
  '1100', '', '', '', '0001', '1000', '0100', '0010',
  '0002', '2000', '0200', '0020', '0201', '1020', '0102', '2010'
]

/** The dashed variants: `[vertical, dashCount, heavy]`. Drawn as real dashes rather than as their
 *  solid equivalents — a dashed rule that renders solid is a different character, and unlike the
 *  solid lines these are not supposed to tile. */
const DASHED: Readonly<Record<number, readonly [boolean, number, boolean]>> = {
  0x2504: [false, 3, false], 0x2505: [false, 3, true],
  0x2506: [true, 3, false], 0x2507: [true, 3, true],
  0x2508: [false, 4, false], 0x2509: [false, 4, true],
  0x250a: [true, 4, false], 0x250b: [true, 4, true],
  0x254c: [false, 2, false], 0x254d: [false, 2, true],
  0x254e: [true, 2, false], 0x254f: [true, 2, true]
}

// ---------------------------------------------------------------------------------------------
// Block elements — the eighths table
// ---------------------------------------------------------------------------------------------

/**
 * U+2580–U+259F as rectangles on an 8×8 sub-cell grid (`[x, y, w, h]` in eighths), the same
 * quantisation xterm's `blockElementDefinitions` uses — these characters are DEFINED in halves,
 * quarters and eighths of the cell, so eighths is the grid on which they are exact.
 *
 * The three shade blocks ░▒▓ are not in here: they are a full-cell fill at increasing alpha
 * (`SHADES`), which is how every renderer draws them.
 */
const BLOCKS: Readonly<Record<number, readonly (readonly [number, number, number, number])[]>> = {
  0x2580: [[0, 0, 8, 4]], // ▀ upper half
  0x2581: [[0, 7, 8, 1]], // ▁ lower one eighth
  0x2582: [[0, 6, 8, 2]], // ▂ lower one quarter
  0x2583: [[0, 5, 8, 3]], // ▃ lower three eighths
  0x2584: [[0, 4, 8, 4]], // ▄ lower half
  0x2585: [[0, 3, 8, 5]], // ▅ lower five eighths
  0x2586: [[0, 2, 8, 6]], // ▆ lower three quarters
  0x2587: [[0, 1, 8, 7]], // ▇ lower seven eighths
  0x2588: [[0, 0, 8, 8]], // █ full block
  0x2589: [[0, 0, 7, 8]], // ▉ left seven eighths
  0x258a: [[0, 0, 6, 8]], // ▊ left three quarters
  0x258b: [[0, 0, 5, 8]], // ▋ left five eighths
  0x258c: [[0, 0, 4, 8]], // ▌ left half
  0x258d: [[0, 0, 3, 8]], // ▍ left three eighths
  0x258e: [[0, 0, 2, 8]], // ▎ left one quarter
  0x258f: [[0, 0, 1, 8]], // ▏ left one eighth
  0x2590: [[4, 0, 4, 8]], // ▐ right half
  0x2594: [[0, 0, 8, 1]], // ▔ upper one eighth
  0x2595: [[7, 0, 1, 8]], // ▕ right one eighth
  0x2596: [[0, 4, 4, 4]], // ▖ quadrant lower left
  0x2597: [[4, 4, 4, 4]], // ▗ quadrant lower right
  0x2598: [[0, 0, 4, 4]], // ▘ quadrant upper left
  0x2599: [[0, 0, 4, 8], [0, 4, 8, 4]], // ▙ upper left + lower left + lower right
  0x259a: [[0, 0, 4, 4], [4, 4, 4, 4]], // ▚ upper left + lower right
  0x259b: [[0, 0, 4, 8], [4, 0, 4, 4]], // ▛ upper left + upper right + lower left
  0x259c: [[0, 0, 8, 4], [4, 0, 4, 8]], // ▜ upper left + upper right + lower right
  0x259d: [[4, 0, 4, 4]], // ▝ quadrant upper right
  0x259e: [[4, 0, 4, 4], [0, 4, 4, 4]], // ▞ upper right + lower left
  0x259f: [[4, 0, 4, 8], [0, 4, 8, 4]] // ▟ upper right + lower left + lower right
}

/** ░▒▓ — a full-cell fill at a third, a half and two thirds… in practice the conventional
 *  quarter/half/three-quarter ramp every terminal renderer uses. The only contract the rest of the
 *  system relies on is that they are strictly increasing. */
const SHADES: Readonly<Record<number, number>> = {
  0x2591: 0.25,
  0x2592: 0.5,
  0x2593: 0.75
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/**
 * Geometric ops for one code point, in cell-local device pixels, or `null` when this module has
 * nothing to say about it — the caller then draws the glyph with the font, exactly as before.
 *
 * `null` is the important half of the contract: it is what keeps this module OPT-IN per code
 * point. Everything outside U+2500–U+259F, the diagonals, and any cell size that is not a
 * positive number falls through to `fillText`.
 */
export function boxGlyphOps(code: number, cellW: number, cellH: number): PaintOp[] | null {
  if (!Number.isFinite(cellW) || !Number.isFinite(cellH) || cellW <= 0 || cellH <= 0) return null
  if (code >= 0x2580 && code <= 0x259f) return blockOps(code, cellW, cellH)
  if (code >= 0x2500 && code <= 0x257f) return boxOps(code, cellW, cellH)
  return null
}

function blockOps(code: number, cellW: number, cellH: number): PaintOp[] | null {
  const shade = SHADES[code]
  if (shade !== undefined) return [{ x: 0, y: 0, w: cellW, h: cellH, alpha: shade }]
  const spec = BLOCKS[code]
  if (!spec) return null
  const ops: PaintOp[] = []
  for (const [x, y, w, h] of spec) {
    push(ops, cellW, cellH, (x / 8) * cellW, (y / 8) * cellH, ((x + w) / 8) * cellW, ((y + h) / 8) * cellH)
  }
  return ops
}

function boxOps(code: number, cellW: number, cellH: number): PaintOp[] | null {
  const dash = DASHED[code]
  if (dash) return dashOps(dash[0], dash[1], dash[2], cellW, cellH)

  const arms = ARMS[code - 0x2500]
  if (!arms) return null

  const light = lightWidth(cellH)
  const heavy = light * 2
  const t = (w: number): number => (w === 1 ? light : w === 2 ? heavy : w === 3 ? light * 3 : 0)

  const up = arms.charCodeAt(0) - 48
  const right = arms.charCodeAt(1) - 48
  const down = arms.charCodeAt(2) - 48
  const left = arms.charCodeAt(3) - 48

  const cx = cellW / 2
  const cy = cellH / 2
  // How far the PERPENDICULAR stem reaches across the junction. An arm must extend half of this
  // past the centre or the far quadrant of the corner stays unfilled — the notch a naive
  // "draw each arm from the edge to the centre" produces on every ┐┘└┌.
  const vSpan = Math.max(t(up), t(down))
  const hSpan = Math.max(t(left), t(right))
  const ops: PaintOp[] = []

  // Horizontal. A through-line of equal weight is ONE rect edge to edge: two overlapping arms
  // would paint the same pixels, and the single rect is what the full-cell invariant is easiest
  // to read off.
  if (left !== 0 && left === right && left !== 3) {
    const th = t(left)
    push(ops, cellW, cellH, 0, cy - th / 2, cellW, cy + th / 2)
  } else {
    if (left === 3) pushDoubleArm(ops, cellW, cellH, false, -1, light, cx, cy, right, up, down, vSpan)
    else if (left !== 0) pushArm(ops, cellW, cellH, false, -1, t(left), cx, cy, vSpan, right !== 0, up === 3 || down === 3, light)
    if (right === 3) pushDoubleArm(ops, cellW, cellH, false, 1, light, cx, cy, left, up, down, vSpan)
    else if (right !== 0) pushArm(ops, cellW, cellH, false, 1, t(right), cx, cy, vSpan, left !== 0, up === 3 || down === 3, light)
  }

  // Vertical — the same three cases, transposed.
  if (up !== 0 && up === down && up !== 3) {
    const th = t(up)
    push(ops, cellW, cellH, cx - th / 2, 0, cx + th / 2, cellH)
  } else {
    if (up === 3) pushDoubleArm(ops, cellW, cellH, true, -1, light, cx, cy, down, left, right, hSpan)
    else if (up !== 0) pushArm(ops, cellW, cellH, true, -1, t(up), cx, cy, hSpan, down !== 0, left === 3 || right === 3, light)
    if (down === 3) pushDoubleArm(ops, cellW, cellH, true, 1, light, cx, cy, up, left, right, hSpan)
    else if (down !== 0) pushArm(ops, cellW, cellH, true, 1, t(down), cx, cy, hSpan, up !== 0, left === 3 || right === 3, light)
  }

  return ops
}

/**
 * The stroke width of a LIGHT line, in device px.
 *
 * Derived from the cell HEIGHT because that is what tracks the font size across dpr (the width
 * varies with the face's advance ratio). `cellH / 16` lands on 1 device px at a typical 13px font
 * on a 1x display and 2 on a retina one, which is what xterm's own `lineWidth` resolves to — thin
 * enough to read as a rule rather than a bar. Never 0: a zero-width line is an invisible one.
 */
function lightWidth(cellH: number): number {
  return Math.max(1, Math.round(cellH / 16))
}

/**
 * One light/heavy arm, from its cell EDGE inward.
 *
 * `dir` is -1 for the left/up arm and +1 for the right/down one; the arm always starts at the
 * corresponding cell edge (the full-cell invariant) and stops at an inner bound:
 *
 * - a **through** arm (its opposite number exists) or a plain corner/tee stops half the
 *   perpendicular stem past the centre, which fills the junction square;
 * - a **stem** meeting a DOUBLE perpendicular (┬ on ═, i.e. ╤ ╥ ╟ ╢ …) instead stops at the near
 *   rail, so the single line ends where the double line begins rather than crossing both rails and
 *   leaving a stub sticking out the far side.
 */
function pushArm(
  ops: PaintOp[],
  cellW: number,
  cellH: number,
  vertical: boolean,
  dir: -1 | 1,
  thick: number,
  cx: number,
  cy: number,
  perpSpan: number,
  hasOpposite: boolean,
  perpIsDouble: boolean,
  light: number
): void {
  const centre = vertical ? cy : cx
  const inner =
    perpIsDouble && !hasOpposite
      ? centre + dir * (light / 2)
      : centre - dir * (Math.max(perpSpan, thick) / 2)
  const cross = vertical ? cx : cy
  const a = cross - thick / 2
  const b = cross + thick / 2
  const from = dir === -1 ? 0 : inner
  const to = dir === -1 ? inner : vertical ? cellH : cellW
  if (vertical) push(ops, cellW, cellH, a, from, b, to)
  else push(ops, cellW, cellH, from, a, to, b)
}

/**
 * One DOUBLE arm: two light rails offset ±`light` from the centre line.
 *
 * Where each rail stops is the whole subtlety of the double family, and it is decided by two
 * questions:
 *
 * 1. **Is the opposite arm also double?** Then the rails run edge to edge (═ ║ ╪ ╫ ╬) and only the
 *    `dir === 1` side emits, so the pair is not drawn twice.
 * 2. **Is there a double arm on the perpendicular axis?** If not, the rails stop where the (single
 *    or heavy) perpendicular stem is — the same `perpSpan / 2` rule `pushArm` uses — so the two
 *    meet flush instead of the rails poking out the far side of the line they land on (╥ ╨ ╞ ╡).
 *    If there is, each rail stops at the perpendicular rail it corners with: the rail on the SAME
 *    side as the perpendicular arm's direction is the INNER corner (it stops at the near rail), the
 *    other is the OUTER corner (it runs on to the far rail). That single rule is what makes ╔╗╚╝
 *    come out as proper double corners and ╠╣╦╩ as proper double tees.
 */
function pushDoubleArm(
  ops: PaintOp[],
  cellW: number,
  cellH: number,
  vertical: boolean,
  dir: -1 | 1,
  light: number,
  cx: number,
  cy: number,
  opposite: number,
  perpA: number,
  perpB: number,
  perpSpan: number
): void {
  // perpA is the -1 side of the perpendicular axis (up for a horizontal arm, left for a vertical
  // one), perpB the +1 side.
  if (opposite === 3 && dir === -1) return
  const centre = vertical ? cy : cx
  const cross = vertical ? cx : cy
  const far = vertical ? cellH : cellW
  const bothPerp = perpA === 3 && perpB === 3
  const anyPerp = perpA === 3 || perpB === 3

  for (const side of [-1, 1] as const) {
    const railCentre = cross + side * light
    const a = railCentre - light / 2
    const b = railCentre + light / 2
    let inner: number
    if (opposite === 3) inner = dir === -1 ? far : 0
    else if (!anyPerp) inner = centre - (dir * Math.max(perpSpan, light)) / 2
    else {
      const matches = bothPerp || (side === -1 && perpA === 3) || (side === 1 && perpB === 3)
      inner = matches ? centre + dir * light : centre - dir * light
    }
    const from = dir === -1 ? 0 : inner
    const to = dir === -1 ? inner : far
    if (vertical) push(ops, cellW, cellH, a, from, b, to)
    else push(ops, cellW, cellH, from, a, to, b)
  }
}

/** The dashed rules: `count` evenly spaced dashes with `count` gaps, centred on the cell's mid
 *  line. Unlike the solid lines these deliberately do NOT reach the cell edges — the gap IS the
 *  character. */
function dashOps(
  vertical: boolean,
  count: number,
  heavy: boolean,
  cellW: number,
  cellH: number
): PaintOp[] {
  const light = lightWidth(cellH)
  const thick = heavy ? light * 2 : light
  const extent = vertical ? cellH : cellW
  const cross = (vertical ? cellW : cellH) / 2
  const a = cross - thick / 2
  const b = cross + thick / 2
  // A dash plus its trailing gap is one period; the dash gets two thirds of it, which is the
  // proportion the reference glyphs use and keeps the shortest dash at least a pixel.
  const period = extent / count
  const ops: PaintOp[] = []
  for (let i = 0; i < count; i++) {
    const from = i * period
    const to = from + period * (2 / 3)
    if (vertical) push(ops, cellW, cellH, a, from, b, to)
    else push(ops, cellW, cellH, from, a, to, b)
  }
  return ops
}

/**
 * Append one rect, snapping INTERIOR edges to whole device pixels and leaving edges that sit on
 * the cell boundary exactly where they are.
 *
 * Both halves matter. Snapping the interior is what stops a 1px rule from being antialiased across
 * two texel columns (which is what "blocky/soft" looked like in the report). NOT snapping the
 * boundary is the full-cell invariant: `cellW` is fractional in general, so `Math.round(cellW)`
 * would leave a sub-pixel of background between two adjacent ─ cells — the gap this module exists
 * to close. A rect that rounds away to nothing is kept at one pixel: an invisible line is worse
 * than a slightly fat one.
 */
function push(ops: PaintOp[], cellW: number, cellH: number, x0: number, y0: number, x1: number, y1: number): void {
  const x = snap(x0, cellW)
  const y = snap(y0, cellH)
  const w = Math.max(1, snap(x1, cellW) - x)
  const h = Math.max(1, snap(y1, cellH) - y)
  ops.push({ x, y, w, h })
}

function snap(v: number, extent: number): number {
  if (v <= 0) return 0
  if (v >= extent) return extent
  return Math.round(v)
}
