import { describe, expect, it } from 'vitest'
import { packColor } from './cells'
import { decorationAt, type DecorationReader } from './decorations'

/** The fake the whole module is tested against — the same shape the attach shell builds over
 *  xterm's `_decorationService`, and the reason this module never sees xterm at all. */
function reader(
  entries: Array<{ col: number; row: number; layer?: string; bg?: number; fg?: number }>
): DecorationReader & { walks: number } {
  const r = {
    walks: 0,
    empty: (): boolean => entries.length === 0,
    atCell: (col: number, row: number, cb: (d: { layer?: string; bg?: number; fg?: number }) => void): void => {
      r.walks++
      entries.filter((e) => e.col === col && e.row === row).forEach(cb)
    }
  }
  return r
}

describe('decorationAt', () => {
  it('returns null when the terminal has no decorations', () => {
    expect(decorationAt(reader([]), 0, 0)).toBeNull()
  })

  it('skips the per-cell walk entirely when the reader reports empty', () => {
    // The common case by a wide margin — nobody has ⌘F open — and this runs per CELL, so the
    // answer has to cost one boolean and nothing else.
    const r = reader([])
    decorationAt(r, 0, 0)
    expect(r.walks).toBe(0)
  })

  it('returns the background a search hit paints', () => {
    const bg = packColor(255, 200, 0, 255)
    expect(decorationAt(reader([{ col: 3, row: 1, bg }]), 3, 1)).toEqual({ bg, fg: undefined })
  })

  it('returns a foreground override too', () => {
    const fg = packColor(0, 0, 0, 255)
    expect(decorationAt(reader([{ col: 3, row: 1, fg }]), 3, 1)).toEqual({ bg: undefined, fg })
  })

  it('returns null for a cell no decoration covers', () => {
    const bg = packColor(255, 200, 0, 255)
    expect(decorationAt(reader([{ col: 3, row: 1, bg }]), 4, 1)).toBeNull()
  })

  it('ignores the TOP layer — xterm paints those over the text itself, not as a cell colour', () => {
    const bg = packColor(255, 200, 0, 255)
    expect(decorationAt(reader([{ col: 3, row: 1, layer: 'top', bg }]), 3, 1)).toBeNull()
  })

  it('treats a decoration with no layer as the BOTTOM layer, exactly as xterm defaults it', () => {
    const bg = packColor(255, 200, 0, 255)
    expect(decorationAt(reader([{ col: 3, row: 1, layer: 'bottom', bg }]), 3, 1)).toEqual({
      bg,
      fg: undefined
    })
  })

  it('returns null when the only decoration on the cell carries no colours', () => {
    // A marker-only decoration (an element in the overlay, no cell colours) must not turn into a
    // black cell — it has nothing to say about this cell's paint.
    expect(decorationAt(reader([{ col: 0, row: 0 }]), 0, 0)).toBeNull()
  })

  it('lets a later decoration win, matching xterm’s last-writer order', () => {
    const first = packColor(10, 10, 10, 255)
    const second = packColor(20, 20, 20, 255)
    expect(
      decorationAt(
        reader([
          { col: 0, row: 0, bg: first },
          { col: 0, row: 0, bg: second }
        ]),
        0,
        0
      )
    ).toEqual({ bg: second, fg: undefined })
  })

  it('keeps an earlier override the later decoration does not restate', () => {
    // Two decorations on one cell, each carrying only half the pair: the fg from the first survives
    // the second's bg — "last writer" is per CHANNEL, which is how xterm's own accumulation reads.
    const fg = packColor(1, 2, 3, 255)
    const bg = packColor(4, 5, 6, 255)
    expect(
      decorationAt(
        reader([
          { col: 0, row: 0, fg },
          { col: 0, row: 0, bg }
        ]),
        0,
        0
      )
    ).toEqual({ bg, fg })
  })
})
