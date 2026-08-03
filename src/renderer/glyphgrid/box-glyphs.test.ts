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

  it('the shades are full-cell ALPHA fills, strictly increasing ░ < ▒ < ▓', () => {
    const light = ops('░')
    const medium = ops('▒')
    const dark = ops('▓')
    for (const l of [light, medium, dark]) {
      expect(l).toHaveLength(1)
      expect(l[0]).toMatchObject({ x: 0, y: 0, w: W, h: H })
    }
    expect(light[0].alpha!).toBeLessThan(medium[0].alpha!)
    expect(medium[0].alpha!).toBeLessThan(dark[0].alpha!)
    expect(dark[0].alpha!).toBeLessThan(1)
  })

  it('only the shades carry an alpha — everything else is opaque ink', () => {
    for (const ch of ['─', '┼', '█', '▀', '╬']) {
      for (const o of ops(ch)) expect(o.alpha).toBeUndefined()
    }
  })
})
