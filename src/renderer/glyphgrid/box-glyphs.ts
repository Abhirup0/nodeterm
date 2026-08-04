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
 *   parallel light rails; where two double arms meet, each rail stops at the EDGE of the near or
 *   the far perpendicular rail (see `pushDoubleArm` — stopping at the rail's centre line is what
 *   left a 1px hole in every ╔╗╚╝ elbow in the first cut of this module). This is exact for the
 *   corners and the plain crossings, and slightly over-draws the tees (╠╣╦╩ keep the crossing rail
 *   continuous where the real glyph breaks it). Every case connects edge-to-edge, which is the
 *   property that matters.
 * - **Heavy/light is a thickness distinction only** — heavy is exactly twice light, which is what
 *   xterm does too.
 */

/**
 * One axis-aligned, fully OPAQUE fill, in CELL-LOCAL device pixels.
 *
 * There is deliberately no alpha channel. The one family that looked like it wanted one — the
 * shade blocks ░▒▓ — is a dither pattern, not a tint (see `SHADES`), and an alpha field would
 * make it possible to "simplify" them back into flat washes that no longer match the renderer
 * beside them. Everything this module draws is ink or nothing.
 *
 * "Opaque" is about the ALPHA, not about a particular colour: `raster.ts` has already filled the
 * slot with the cell's real BACKGROUND, and it fills these rects in the cell's real FOREGROUND, so a
 * set pixel is fully fg and every other pixel is left as bg — the same two states the `fillText`
 * path produces on a colour-keyed atlas, and the reason this module never touches `globalAlpha`.
 */
export interface PaintOp {
  x: number
  y: number
  w: number
  h: number
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

/**
 * ░▒▓ — DITHER PATTERNS, transcribed from xterm's `patternCharacterDefinitions`, which both of its
 * renderers use.
 *
 * Each entry is a bitmap of DEVICE pixels — one array element per pixel, not per fraction of the
 * cell — tiled from the cell's top-left across the whole cell. `1` is an opaque pixel, `0` is bare
 * background.
 *
 * These are NOT flat alpha fills, and the difference is the whole point. A shade block is a
 * STIPPLE: at normal reading size the eye integrates the dither into a tint, but the texture is
 * visible, it does not change with the cell size (the pattern is pinned to device pixels, so a
 * bigger cell shows more dots rather than bigger ones), and it composites against whatever is
 * behind it exactly the way the DOM renderer's does. A flat `globalAlpha` fill — what round 4
 * shipped first — reads as a smooth wash and is instantly distinguishable from the per-terminal
 * renderer in the side-by-side comparison the checklist asks for.
 *
 * The coverage ratios that fall out of the tables are 2/16, 2/8 and 6/8. xterm's own comments label
 * them 25/50/75%, which the tables do not literally produce; matching xterm's PIXELS is the point
 * here, not matching its comments, so the tables are transcribed as they are. The contract the
 * tests hold is the ordering: ░ < ▒ < ▓.
 */
const SHADES: Readonly<Record<number, readonly (readonly number[])[]>> = {
  0x2591: [
    // ░ LIGHT SHADE — 2 of 16 device px
    [1, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 0]
  ],
  0x2592: [
    // ▒ MEDIUM SHADE — 2 of 8
    [1, 0],
    [0, 0],
    [0, 1],
    [0, 0]
  ],
  0x2593: [
    // ▓ DARK SHADE — 6 of 8
    [0, 1],
    [1, 1],
    [1, 0],
    [1, 1]
  ]
}

// ---------------------------------------------------------------------------------------------
// Miscellaneous Technical — the line-art aliases
// ---------------------------------------------------------------------------------------------

/**
 * Code points OUTSIDE U+2500–U+259F that are the SAME SHAPE as something already in the arm table,
 * mapped onto their primitive. The map is consulted first in `boxGlyphOps`, so these are drawn by
 * the geometry above rather than by the font — one copy of the geometry, reached by two names.
 *
 * WHY these are here and not left to `fillText` (device round, 2026-08-04). U+23BF ⎿ is Claude
 * Code's tool-result connector, and in shared mode its horizontal foot rendered as a stub: measured
 * off the two screenshots at the same content and zoom, GPU per terminal drew the foot from x 48 to
 * 75 (28 px, about one cell) while shared drew x 51 to 58 (8 px). The foot was not missing, it was
 * TRUNCATED — the face (or Chromium's fallback for it) draws this glyph's ink wider than the
 * terminal cell, and `raster.ts` clips every font-drawn glyph to the cell so the overflow is
 * discarded. xterm's own `TextureAtlas` never meets this: it measures each glyph's real bounding
 * box and stores/renders it at true size, letting ink overflow into the neighbouring cells, which
 * is why GPU mode shows the whole foot.
 *
 * So this is the same argument the module header makes for U+2500–U+259F, arriving from the other
 * side: line art that a font draws at whatever size it likes does not survive a per-cell atlas.
 * DRAWING it removes the dependency entirely — a `└` we generate is full-cell by construction. Do
 * not "simplify" the map away on the grounds that the font can draw these characters; it can, and
 * the cell is what cannot hold the result.
 *
 * DELIBERATELY NOT HERE: U+23B8 ⎸ and U+23B9 ⎹ (LEFT/RIGHT VERTICAL BOX LINE). They were considered
 * and rejected — they sit flush on the cell's left/right EDGE, whereas U+2502 │ is CENTRED, so they
 * are NEW geometry rather than a second name for a shape in the table. They keep using the font.
 */
const ALIASES: Readonly<Record<number, number>> = {
  0x23bf: 0x2514, // ⎿ DENTISTRY SYMBOL LIGHT VERTICAL AND BOTTOM RIGHT → └ (up + right)
  0x23be: 0x250c, // ⎾ DENTISTRY SYMBOL LIGHT VERTICAL AND TOP RIGHT → ┌ (down + right)
  0x23af: 0x2500, // ⎯ HORIZONTAL LINE EXTENSION → ─
  0x23d0: 0x2502 // ⏐ VERTICAL LINE EXTENSION → │
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/**
 * Geometric ops for one code point, in cell-local device pixels, or `null` when this module has
 * nothing to say about it — the caller then draws the glyph with the font, exactly as before.
 *
 * `null` is the important half of the contract: it is what keeps this module OPT-IN per code
 * point. Everything outside U+2500–U+259F and the four `ALIASES`, the diagonals, and any cell size
 * that is not a positive number falls through to `fillText`.
 */
export function boxGlyphOps(code: number, cellW: number, cellH: number): PaintOp[] | null {
  if (!Number.isFinite(cellW) || !Number.isFinite(cellH) || cellW <= 0 || cellH <= 0) return null
  // The aliases resolve to a code point in the box-drawing range and then take the ORDINARY path,
  // so an alias is bit-identical to its primitive at every cell size by construction.
  const alias = ALIASES[code]
  if (alias !== undefined) return boxOps(alias, cellW, cellH)
  if (code >= 0x2580 && code <= 0x259f) return blockOps(code, cellW, cellH)
  if (code >= 0x2500 && code <= 0x257f) return boxOps(code, cellW, cellH)
  return null
}

function blockOps(code: number, cellW: number, cellH: number): PaintOp[] | null {
  const shade = SHADES[code]
  if (shade) return stippleOps(shade, cellW, cellH)
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
      // Which perpendicular rail does this one corner with? The rail on the SAME side as the
      // perpendicular arm's direction is the INNER corner and stops at the NEAR rail; the other is
      // the OUTER corner and runs on to the FAR rail.
      //
      // The stop is the rail's own EDGE, not its centre line. A rail of thickness `light` centred
      // at `centre ± light` spans `centre ± 0.5·light` … `centre ± 1.5·light`, so stopping at the
      // centre line covers only HALF the rail it is supposed to corner with and leaves a
      // 1-device-px hole at the elbow — reproducible at every cell size on ╔╗╚╝, and the reason the
      // header's "exact for the corners" claim was false before round 4. Near edge is
      // `centre + dir·0.5·light`; far edge is `centre − dir·1.5·light`.
      const matches = bothPerp || (side === -1 && perpA === 3) || (side === 1 && perpB === 3)
      inner = matches ? centre + dir * 0.5 * light : centre - dir * 1.5 * light
    }
    const from = dir === -1 ? 0 : inner
    const to = dir === -1 ? inner : far
    if (vertical) push(ops, cellW, cellH, a, from, b, to)
    else push(ops, cellW, cellH, from, a, to, b)
  }
}

/**
 * Tile a dither pattern across the cell, one rect per RUN of set pixels in a pattern row.
 *
 * Runs rather than individual pixels: ▓ on a retina cell is ~80 tiles, and emitting its six set
 * pixels separately would be ~480 ops where ~320 will do. This is rasterized once per atlas slot,
 * so the cost is not on any hot path — but the op list is also what a future direct-to-GPU path
 * would upload, and a list that is twice as long as it needs to be is a bad default.
 *
 * The last tile in each direction is clipped by the cell bound (`push` clamps), so a cell that is
 * not a whole multiple of the pattern simply shows a partial tile — which is what a repeating
 * pattern does everywhere else, including xterm's `createPattern`.
 */
function stippleOps(pattern: readonly (readonly number[])[], cellW: number, cellH: number): PaintOp[] {
  const ph = pattern.length
  const pw = pattern[0].length
  const ops: PaintOp[] = []
  for (let ty = 0; ty < cellH; ty += ph) {
    for (let row = 0; row < ph; row++) {
      const y = ty + row
      if (y >= cellH) break
      for (let tx = 0; tx < cellW; tx += pw) {
        let col = 0
        while (col < pw) {
          if (!pattern[row][col]) {
            col++
            continue
          }
          const start = col
          while (col < pw && pattern[row][col]) col++
          const x0 = tx + start
          if (x0 >= cellW) break
          push(ops, cellW, cellH, x0, y, Math.min(tx + col, cellW), y + 1)
        }
      }
    }
  }
  return ops
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
 * than a slightly fat one — but it is grown INWARD (`span` below), never off the end of the cell.
 */
function push(ops: PaintOp[], cellW: number, cellH: number, x0: number, y0: number, x1: number, y1: number): void {
  const [x, w] = span(x0, x1, cellW)
  const [y, h] = span(y0, y1, cellH)
  ops.push({ x, y, w, h })
}

/**
 * One axis of `push`: snap both edges, then guarantee at least one device pixel of extent WITHOUT
 * leaving the cell.
 *
 * The naive `Math.max(1, b - a)` overshoots. `▕` (right one eighth) on a 7.83px-wide cell snaps to
 * `a = 7`, `b = 7.83`; forcing `w = 1` puts the right edge at 8, a sixth of a pixel outside the
 * cell. It is harmless in practice — the rasterizer clips every draw to the slot — but a rule that
 * survives only because someone else catches it is not an invariant, and the next consumer of these
 * ops (a future GPU path that uploads them directly, say) would not clip. Growing inward keeps
 * `x + w <= cellW` true by construction.
 */
function span(v0: number, v1: number, extent: number): [number, number] {
  const a = snap(v0, extent)
  let b = snap(v1, extent)
  if (b - a >= 1) return [a, b - a]
  b = Math.min(extent, a + 1)
  return [Math.max(0, b - 1), b - Math.max(0, b - 1)]
}

function snap(v: number, extent: number): number {
  if (v <= 0) return 0
  if (v >= extent) return extent
  return Math.round(v)
}
