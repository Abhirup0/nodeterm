import { describe, expect, it } from 'vitest'
import { boxGlyphOps, type PaintOp } from './box-glyphs'

// The cell used by most of these: 10 × 20 device px, so light = round(20/16) = 1 and the centre
// lines fall on .0 / .0 — the arithmetic is checkable by hand.
const W = 10
const H = 20

function ops(ch: string, cellW = W, cellH = H): PaintOp[] {
  const r = boxGlyphOps(ch.codePointAt(0)!, cellW, cellH)
  expect(r).not.toBeNull()
  return r!
}

/** Total ink coverage of an op list, counting a pixel once (the ops may overlap at a junction). */
function covered(list: PaintOp[], cellW: number, cellH: number): Set<string> {
  const set = new Set<string>()
  for (const o of list) {
    for (let y = Math.floor(o.y); y < Math.ceil(o.y + o.h); y++) {
      for (let x = Math.floor(o.x); x < Math.ceil(o.x + o.w); x++) {
        if (x >= 0 && y >= 0 && x < Math.ceil(cellW) && y < Math.ceil(cellH)) set.add(`${x},${y}`)
      }
    }
  }
  return set
}

describe('boxGlyphOps — the range gate', () => {
  it('returns null for ordinary text, so it falls through to fillText', () => {
    expect(boxGlyphOps(0x41, W, H)).toBeNull() // 'A'
    expect(boxGlyphOps(0x20, W, H)).toBeNull() // space
    expect(boxGlyphOps(0x4e2d, W, H)).toBeNull() // 中
  })

  it('returns null for the DIAGONALS — a rect list cannot express them (v1 font fallback)', () => {
    for (const ch of ['╱', '╲', '╳']) {
      expect(boxGlyphOps(ch.codePointAt(0)!, W, H)).toBeNull()
    }
  })

  it('returns null for a degenerate cell instead of emitting NaN rects', () => {
    expect(boxGlyphOps(0x2500, 0, H)).toBeNull()
    expect(boxGlyphOps(0x2500, W, 0)).toBeNull()
    expect(boxGlyphOps(0x2500, Number.NaN, H)).toBeNull()
  })

  it('covers the whole box-drawing and block ranges except the three diagonals', () => {
    const missing: string[] = []
    for (let c = 0x2500; c <= 0x259f; c++) {
      if (c >= 0x2571 && c <= 0x2573) continue
      if (boxGlyphOps(c, W, H) === null) missing.push(c.toString(16))
    }
    expect(missing).toEqual([])
  })
})

describe('box drawing — the full-cell invariant', () => {
  it('U+2500 ─ is ONE rect spanning the full width at centred thickness', () => {
    const [r, ...rest] = ops('─')
    expect(rest).toEqual([])
    expect(r.x).toBe(0)
    expect(r.x + r.w).toBe(W) // exactly the cell edge — the anti-gap rule
    expect(r.h).toBe(1) // light at cellH 20
    // A 1px rule cannot be centred to better than half a pixel on an even cell.
    expect(Math.abs(r.y + r.h / 2 - H / 2)).toBeLessThanOrEqual(1)
  })

  it('U+2502 │ is ONE rect spanning the full height at centred thickness', () => {
    const [r, ...rest] = ops('│')
    expect(rest).toEqual([])
    expect(r.y).toBe(0)
    expect(r.y + r.h).toBe(H)
    expect(r.w).toBe(1)
    expect(Math.abs(r.x + r.w / 2 - W / 2)).toBeLessThanOrEqual(1)
  })

  it('a FRACTIONAL cell still ends exactly on the boundary — no sub-pixel gap is representable', () => {
    // 8.4 × 17.6 is the shape of a real device cell (charWidth * dpr). Rounding the outer edge
    // here is what put a hairline between every pair of ─ cells.
    const [r] = ops('─', 8.4, 17.6)
    expect(r.x).toBe(0)
    expect(r.x + r.w).toBe(8.4)
    const [v] = ops('│', 8.4, 17.6)
    expect(v.y).toBe(0)
    expect(v.y + v.h).toBe(17.6)
  })

  it('the HEAVY line is thicker than the light one, both still full width', () => {
    const [light] = ops('─', W, 64)
    const [heavy] = ops('━', W, 64)
    expect(heavy.h).toBe(light.h * 2)
    expect(heavy.x).toBe(0)
    expect(heavy.x + heavy.w).toBe(W)
  })

  it('never emits a zero-sized rect, however small the cell', () => {
    for (const [cw, ch] of [
      [1, 1],
      [3, 5],
      [6.2, 11.7]
    ] as const) {
      for (const glyph of ['─', '│', '┼', '╬', '█', '▏']) {
        for (const o of ops(glyph, cw, ch)) {
          expect(o.w).toBeGreaterThanOrEqual(1)
          expect(o.h).toBeGreaterThanOrEqual(1)
        }
      }
    }
  })

  it('no op ever leaves the cell, at any cell size — growing a thin rect grows it INWARD', () => {
    // `▕` (right one eighth) on a 7.83px cell snaps to x=7 with 0.83px of room; forcing w=1 used to
    // put the right edge at 8. Harmless (the rasterizer clips) but an invariant that survives only
    // because someone else catches it is not one.
    const sizes: [number, number][] = [
      [5.3, 9],
      [7.83, 17.6], // the reported case
      [10, 20],
      [13.4, 29.7],
      [17, 34],
      [25.5, 51]
    ]
    for (const [cw, ch] of sizes) {
      for (let code = 0x2500; code <= 0x259f; code++) {
        const list = boxGlyphOps(code, cw, ch)
        if (!list) continue
        for (const o of list) {
          expect(o.x).toBeGreaterThanOrEqual(0)
          expect(o.y).toBeGreaterThanOrEqual(0)
          expect(o.x + o.w).toBeLessThanOrEqual(cw)
          expect(o.y + o.h).toBeLessThanOrEqual(ch)
        }
      }
    }
  })
})

describe('box drawing — arms', () => {
  it('┌ produces exactly its two arms: right to the edge, down to the edge, nothing left/up', () => {
    const list = ops('┌')
    expect(list).toHaveLength(2)
    const horizontal = list.find((o) => o.w > o.h)!
    const vertical = list.find((o) => o.h > o.w)!
    expect(horizontal.x + horizontal.w).toBe(W) // reaches the RIGHT edge
    expect(horizontal.x).toBeGreaterThan(0) // does NOT reach the left edge
    expect(vertical.y + vertical.h).toBe(H) // reaches the BOTTOM edge
    expect(vertical.y).toBeGreaterThan(0) // does NOT reach the top edge
  })

  it('┘ is the mirror of ┌ — left and up arms only', () => {
    const list = ops('┘')
    expect(list).toHaveLength(2)
    const horizontal = list.find((o) => o.w > o.h)!
    const vertical = list.find((o) => o.h > o.w)!
    expect(horizontal.x).toBe(0)
    expect(horizontal.x + horizontal.w).toBeLessThan(W)
    expect(vertical.y).toBe(0)
    expect(vertical.y + vertical.h).toBeLessThan(H)
  })

  it('the four corners fill the JUNCTION — an arm extends past the centre, never notches it', () => {
    // The naive "draw each arm from the edge to the centre" leaves the far quadrant of the corner
    // empty. Check the centre pixel is inked for every corner.
    for (const ch of ['┌', '┐', '└', '┘', '╭', '╮', '╯', '╰', '┏', '┓', '┗', '┛']) {
      const set = covered(ops(ch, 12, 24), 12, 24)
      expect(set.has('6,12')).toBe(true)
    }
  })

  it('├ is a full-height vertical plus a right arm to the edge', () => {
    const list = ops('├')
    expect(list).toHaveLength(2)
    const vertical = list.find((o) => o.h > o.w)!
    const horizontal = list.find((o) => o.w > o.h)!
    expect(vertical.y).toBe(0)
    expect(vertical.y + vertical.h).toBe(H)
    expect(horizontal.x + horizontal.w).toBe(W)
    expect(horizontal.x).toBeGreaterThan(0)
  })

  it('┬ is a full-WIDTH horizontal plus a down arm — the through-line is one rect', () => {
    const list = ops('┬')
    expect(list).toHaveLength(2)
    const horizontal = list.find((o) => o.w > o.h)!
    const vertical = list.find((o) => o.h > o.w)!
    expect(horizontal.x).toBe(0)
    expect(horizontal.x + horizontal.w).toBe(W)
    expect(vertical.y + vertical.h).toBe(H)
    expect(vertical.y).toBeGreaterThan(0)
  })

  it('┼ is the full cross: both through-lines edge to edge', () => {
    const list = ops('┼')
    expect(list).toHaveLength(2)
    const horizontal = list.find((o) => o.w > o.h)!
    const vertical = list.find((o) => o.h > o.w)!
    expect([horizontal.x, horizontal.x + horizontal.w]).toEqual([0, W])
    expect([vertical.y, vertical.y + vertical.h]).toEqual([0, H])
  })

  it('the stubs ╴╵╶╷ each produce ONE arm reaching its own edge only', () => {
    const cases: [string, 'l' | 'u' | 'r' | 'd'][] = [
      ['╴', 'l'],
      ['╵', 'u'],
      ['╶', 'r'],
      ['╷', 'd']
    ]
    for (const [ch, side] of cases) {
      const list = ops(ch)
      expect(list).toHaveLength(1)
      const o = list[0]
      if (side === 'l') expect(o.x).toBe(0)
      if (side === 'r') expect(o.x + o.w).toBe(W)
      if (side === 'u') expect(o.y).toBe(0)
      if (side === 'd') expect(o.y + o.h).toBe(H)
    }
  })

  it('a mixed-weight tee keeps each arm at its own weight (┝ = light vertical, heavy right)', () => {
    const list = ops('┝', W, 64)
    const vertical = list.find((o) => o.h > o.w)!
    const horizontal = list.find((o) => o.w > o.h)!
    expect(horizontal.h).toBe(vertical.w * 2)
  })

  it('rounded corners are their SQUARE counterparts in v1 (documented approximation)', () => {
    expect(ops('╭')).toEqual(ops('┌'))
    expect(ops('╮')).toEqual(ops('┐'))
    expect(ops('╯')).toEqual(ops('┘'))
    expect(ops('╰')).toEqual(ops('└'))
  })
})

describe('box drawing — doubles and dashes', () => {
  it('═ is TWO full-width rails, not one line and not four', () => {
    const list = ops('═', W, 64)
    expect(list).toHaveLength(2)
    for (const o of list) {
      expect(o.x).toBe(0)
      expect(o.x + o.w).toBe(W)
    }
    expect(list[0].y).not.toBe(list[1].y)
  })

  it('║ is TWO full-height rails', () => {
    const list = ops('║', 32, H)
    expect(list).toHaveLength(2)
    for (const o of list) {
      expect(o.y).toBe(0)
      expect(o.y + o.h).toBe(H)
    }
  })

  it('╔ is a double corner: each rail reaches its own edge, none reaches the empty quadrant edges', () => {
    const list = ops('╔', 32, 64)
    expect(list).toHaveLength(4)
    const right = list.filter((o) => o.x + o.w === 32)
    const down = list.filter((o) => o.y + o.h === 64)
    expect(right).toHaveLength(2)
    expect(down).toHaveLength(2)
    // Nothing runs to the LEFT or TOP edge — that is the empty quadrant of a ╔.
    expect(list.some((o) => o.x === 0 && o.w > 4)).toBe(false)
    expect(list.some((o) => o.y === 0 && o.h > 4)).toBe(false)
  })

  it('the four double corners have SOLID elbows — no hole where two rails meet', () => {
    // The round-4 review reproduced a hole at the OUTER elbow of every ╔╗╚╝ at every cell size: a
    // rail stopped at the perpendicular rail's centre LINE, so it covered only half of the rail it
    // was supposed to corner with, and a `light × light` square of the elbow was covered by
    // neither. Note this is NOT caught by asking whether the two rails intersect — they do, just
    // not over the whole elbow.
    //
    // The elbow square is derived from the EMITTED rects (the vertical rail gives its x range, the
    // horizontal rail its y range) rather than predicted from the cell size, so the check is exact
    // at any snapping.
    const corners: [string, -1 | 1, -1 | 1][] = [
      // [glyph, direction the horizontal arms point, direction the vertical arms point]
      ['╔', 1, 1],
      ['╗', -1, 1],
      ['╚', 1, -1],
      ['╝', -1, -1]
    ]
    for (const [cw, ch] of [
      [32, 64], // light = 4: a half-rail miss is several px wide
      [16, 32], // light = 2
      [10, 20] // light = 1: the smallest representable miss
    ] as const) {
      for (const [glyph, hx, vy] of corners) {
        const list = ops(glyph, cw, ch)
        expect(list).toHaveLength(4)
        const set = covered(list, cw, ch)
        const horizontals = list.filter((o) => o.w > o.h).sort((a, b) => a.y - b.y)
        const verticals = list.filter((o) => o.h > o.w).sort((a, b) => a.x - b.x)
        expect(horizontals).toHaveLength(2)
        expect(verticals).toHaveLength(2)
        // The OUTER rail of a pair is the one on the far side from where the arms point.
        const [outerH, innerH] = vy === 1 ? horizontals : [...horizontals].reverse()
        const [outerV, innerV] = hx === 1 ? verticals : [...verticals].reverse()
        for (const [h, v, which] of [
          [outerH, outerV, 'outer'],
          [innerH, innerV, 'inner']
        ] as const) {
          for (let x = Math.floor(v.x); x < Math.ceil(v.x + v.w); x++) {
            for (let y = Math.floor(h.y); y < Math.ceil(h.y + h.h); y++) {
              expect(set.has(`${x},${y}`), `${glyph} ${which} elbow (${x},${y}) at ${cw}x${ch}`).toBe(true)
            }
          }
        }
      }
    }
  })

  it('╬ crosses as four rails with an OPEN centre', () => {
    const list = ops('╬', 32, 64)
    expect(list).toHaveLength(4)
    const set = covered(list, 32, 64)
    expect(set.has('16,32')).toBe(false) // the centre square is empty, as in the real glyph
  })

  it('a dashed rule leaves GAPS on purpose — it must not tile like a solid one', () => {
    const list = ops('┄', 24, 32)
    expect(list).toHaveLength(3)
    expect(list[0].x).toBe(0)
    expect(list[list.length - 1].x + list[list.length - 1].w).toBeLessThan(24)
  })

  it('the dash count follows the character (triple / quadruple / double)', () => {
    expect(ops('┄', 24, 32)).toHaveLength(3)
    expect(ops('┈', 24, 32)).toHaveLength(4)
    expect(ops('╌', 24, 32)).toHaveLength(2)
    expect(ops('┆', 24, 32)).toHaveLength(3)
  })
})

describe('Misc-Technical line-art aliases', () => {
  // U+23BF ⎿ is Claude Code's tool-result connector. It is NOT in the box-drawing range, so before
  // the alias map it fell through to `fillText` and the rasterizer's per-slot clip cut the ink the
  // face draws past the cell — the device round measured the foot at 8px where GPU mode drew 28.
  // Each pair below must stay BIT-IDENTICAL to its primitive: the alias delegates, it does not
  // re-derive the geometry.
  const ALIASES: [string, string, string][] = [
    ['⎿', '└', 'U+23BF → U+2514'],
    ['⎾', '┌', 'U+23BE → U+250C'],
    ['⎯', '─', 'U+23AF → U+2500'],
    ['⏐', '│', 'U+23D0 → U+2502']
  ]

  it('each alias produces exactly its primitive at an INTEGRAL cell', () => {
    for (const [alias, primitive, label] of ALIASES) {
      expect(ops(alias), label).toEqual(ops(primitive))
    }
  })

  it('each alias produces exactly its primitive at a FRACTIONAL cell', () => {
    // A fractional cell is where an alias that re-derived its own geometry would drift: `span`/
    // `snap` treat the boundary and the interior differently, so any second copy of the arm code
    // would have to reproduce that exactly.
    for (const [alias, primitive, label] of ALIASES) {
      expect(ops(alias, 10.5, 20.5), label).toEqual(ops(primitive, 10.5, 20.5))
    }
  })

  it('⎿ reaches BOTH its edges — the foot the clip used to eat', () => {
    const list = ops('⎿')
    expect(list).toHaveLength(2)
    const horizontal = list.find((o) => o.w > o.h)!
    const vertical = list.find((o) => o.h > o.w)!
    expect(horizontal.x + horizontal.w).toBe(W) // full-width foot, edge to edge
    expect(vertical.y).toBe(0)
  })

  it('U+23B8 ⎸ and U+23B9 ⎹ are NOT aliases — they stay on the font', () => {
    // Deliberate: these sit flush on the cell's left/right EDGE, not centred like │, so they are new
    // geometry rather than a rename of something in the table.
    expect(boxGlyphOps(0x23b8, W, H)).toBeNull()
    expect(boxGlyphOps(0x23b9, W, H)).toBeNull()
  })

  it('a neighbour outside the map still falls through to the font', () => {
    expect(boxGlyphOps(0x23fa, W, H)).toBeNull() // ⏺ — Claude Code's bullet, not line art
    expect(boxGlyphOps(0x23ba, W, H)).toBeNull() // ⎺ horizontal scan line 1
  })

  it('the map changes nothing in the ranges it sits outside', () => {
    // The alias gate runs BEFORE the two range gates, so a bug there could shadow a real code
    // point. Sweep both ranges and the immediate neighbourhood of the aliases.
    for (let c = 0x2500; c <= 0x259f; c++) {
      if (c >= 0x2571 && c <= 0x2573) continue
      expect(boxGlyphOps(c, W, H), c.toString(16)).not.toBeNull()
    }
    for (let c = 0x2300; c <= 0x23ff; c++) {
      if (c === 0x23af || c === 0x23be || c === 0x23bf || c === 0x23d0) continue
      expect(boxGlyphOps(c, W, H), c.toString(16)).toBeNull()
    }
  })

  it('a degenerate cell still declines an alias instead of emitting NaN rects', () => {
    expect(boxGlyphOps(0x23bf, 0, H)).toBeNull()
    expect(boxGlyphOps(0x23bf, W, Number.NaN)).toBeNull()
  })
})

describe('block elements', () => {
  it('▀ is EXACTLY the top half of the cell', () => {
    const list = ops('▀')
    expect(list).toEqual([{ x: 0, y: 0, w: W, h: H / 2 }])
  })

  it('▄ is exactly the bottom half, and the two tile the cell with no seam', () => {
    const [top] = ops('▀')
    const [bottom] = ops('▄')
    expect(bottom.y).toBe(top.y + top.h) // the seam is shared, not overlapped or gapped
    expect(bottom.y + bottom.h).toBe(H)
  })

  it('█ is the WHOLE cell, to the exact edges', () => {
    expect(ops('█')).toEqual([{ x: 0, y: 0, w: W, h: H }])
    expect(ops('█', 8.4, 17.6)).toEqual([{ x: 0, y: 0, w: 8.4, h: 17.6 }])
  })

  it('▌ and ▐ are the two halves and tile horizontally', () => {
    const [l] = ops('▌')
    const [r] = ops('▐')
    expect(l.x).toBe(0)
    expect(r.x).toBe(l.x + l.w)
    expect(r.x + r.w).toBe(W)
  })

  it('the eighth blocks step monotonically', () => {
    const heights = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'].map((c) => ops(c, 16, 32)[0].h)
    for (let i = 1; i < heights.length; i++) expect(heights[i]).toBeGreaterThan(heights[i - 1])
    expect(heights[heights.length - 1]).toBe(32)
  })

  it('the quadrants are the four corners, and the composites are their unions', () => {
    const ul = covered(ops('▘', 16, 32), 16, 32)
    const ur = covered(ops('▝', 16, 32), 16, 32)
    const ll = covered(ops('▖', 16, 32), 16, 32)
    const lr = covered(ops('▗', 16, 32), 16, 32)
    expect(ul.size).toBe(8 * 16)
    // ▚ = upper-left + lower-right
    const diag = covered(ops('▚', 16, 32), 16, 32)
    expect(diag.size).toBe(ul.size + lr.size)
    // ▟ = upper-right + lower-left + lower-right
    const three = covered(ops('▟', 16, 32), 16, 32)
    expect(three.size).toBe(ur.size + ll.size + lr.size)
  })

  it('the shades are STIPPLES, not flat fills — many 1px rows, none covering the cell', () => {
    // The parity point: xterm draws ░▒▓ from a device-pixel dither table in BOTH its renderers, so
    // a single full-cell rect (at any alpha) is instantly distinguishable in a side-by-side.
    for (const ch of ['░', '▒', '▓']) {
      const list = ops(ch, 16, 32)
      expect(list.length).toBeGreaterThan(8)
      for (const o of list) {
        expect(o.h).toBe(1) // one device-pixel row per op
        expect(o.w).toBeLessThan(16) // never spans the cell
      }
    }
  })

  it('shade DENSITY is strictly increasing ░ < ▒ < ▓, and none of them is solid', () => {
    const density = (ch: string): number => covered(ops(ch, 16, 32), 16, 32).size / (16 * 32)
    const light = density('░')
    const medium = density('▒')
    const dark = density('▓')
    expect(light).toBeGreaterThan(0)
    expect(light).toBeLessThan(medium)
    expect(medium).toBeLessThan(dark)
    expect(dark).toBeLessThan(1)
  })

  it('the stipple is pinned to DEVICE pixels — a bigger cell gets more dots, not bigger ones', () => {
    // This is what makes it a dither rather than a texture: the pattern must not scale with the
    // cell, or a large cell would show a chunky checkerboard instead of a tint.
    const small = ops('▓', 16, 32)
    const large = ops('▓', 32, 64)
    for (const o of [...small, ...large]) expect(o.h).toBe(1)
    expect(large.length).toBeGreaterThan(small.length)
    const d = (l: PaintOp[], w: number, h: number): number => covered(l, w, h).size / (w * h)
    expect(d(large, 32, 64)).toBeCloseTo(d(small, 16, 32), 2)
  })
})
