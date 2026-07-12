import { describe, it, expect } from 'vitest'
import { chipStrip, MAX_CHIPS } from './presenceChips'
import type { PeerFace } from '../state/presence'

function face(clientId: number, over: Partial<PeerFace> = {}): PeerFace {
  return {
    clientId,
    name: `P${clientId}`,
    color: '#5ac8fa',
    projectId: 'web',
    kind: 'browser',
    ...over
  }
}

describe('chipStrip (what a node header draws for the peers focused on it)', () => {
  it('draws nothing when nobody is focused here', () => {
    expect(chipStrip([])).toEqual({ chips: [], overflow: 0, overflowTitle: '' })
  })

  it('draws one chip per peer (initial + color + name tooltip) when they all fit', () => {
    const strip = chipStrip([face(8, { name: 'ada', color: '#ff9f0a' }), face(9, { name: 'Bo' })])
    expect(strip.overflow).toBe(0)
    expect(strip.chips).toEqual([
      { clientId: 8, letter: 'A', color: '#ff9f0a', title: 'ada is here', typing: false },
      { clientId: 9, letter: 'B', color: '#5ac8fa', title: 'Bo is here', typing: false }
    ])
  })

  it('orders by clientId (join order), whatever order the peer table hands them over in', () => {
    const strip = chipStrip([face(11), face(2), face(7)])
    expect(strip.chips.map((c) => c.clientId)).toEqual([2, 7, 11])
  })

  it('falls back to "?" for a peer with a blank name', () => {
    expect(chipStrip([face(8, { name: '   ' })]).chips[0].letter).toBe('?')
  })

  it('fills the strip exactly when the peers equal the cap (no "+0" bubble)', () => {
    const strip = chipStrip([face(1), face(2), face(3)], [], 3)
    expect(strip.chips).toHaveLength(3)
    expect(strip.overflow).toBe(0)
  })

  it('overflows into a "+N" bubble that names everyone it hides', () => {
    const strip = chipStrip(
      [
        face(1, { name: 'Ada' }),
        face(2, { name: 'Bo' }),
        face(3, { name: 'Cy' }),
        face(4, { name: 'Dee' }),
        face(5, { name: 'Eve' })
      ],
      [],
      3
    )
    // A cap of 3 spends the last slot on the bubble: 2 faces + "+3".
    expect(strip.chips.map((c) => c.letter)).toEqual(['A', 'B'])
    expect(strip.overflow).toBe(3)
    expect(strip.overflowTitle).toBe('Cy, Dee, Eve')
  })

  it('has a sane default cap', () => {
    expect(MAX_CHIPS).toBeGreaterThanOrEqual(2)
    const strip = chipStrip(Array.from({ length: MAX_CHIPS + 4 }, (_, i) => face(i + 1)))
    expect(strip.chips).toHaveLength(MAX_CHIPS - 1)
    expect(strip.overflow).toBe(5)
  })
})

describe('chipStrip typists (co-attach: whose keystrokes are landing in THIS shell)', () => {
  it('rings the chip of a focused peer who is typing here', () => {
    const strip = chipStrip([face(1, { name: 'Ada' }), face(2, { name: 'Bo' })], [face(2)])
    expect(strip.chips.map((c) => [c.clientId, c.typing])).toEqual([
      [2, true],
      [1, false]
    ])
    expect(strip.chips[0].title).toBe('P2 is typing in this terminal')
  })

  it('chips a typist who is NOT in the focused list — a phone has no project, and so no focus', () => {
    // The phone (clientId 5) is filtered out of the project-scoped focus list, but its keystrokes
    // are landing in this shell right now: it MUST be drawn, or the ring never fires for a phone.
    const strip = chipStrip([face(1)], [face(5, { name: 'Phone', projectId: null, kind: 'phone' })])
    expect(strip.chips.map((c) => c.clientId)).toEqual([5, 1])
    expect(strip.chips[0].typing).toBe(true)
  })

  it('never chips the same peer twice when they are both focused here and typing here', () => {
    const strip = chipStrip([face(3)], [face(3)])
    expect(strip.chips).toHaveLength(1)
    expect(strip.chips[0].typing).toBe(true)
  })

  it('never hides a typist behind the "+N" bubble — a warning you cannot see warns nobody', () => {
    const strip = chipStrip([face(1), face(2), face(3), face(4)], [face(4)], 3)
    expect(strip.chips.map((c) => c.clientId)).toEqual([4, 1])
    expect(strip.overflow).toBe(2)
    expect(strip.overflowTitle).toBe('P2, P3')
  })

  it('keeps a stable clientId order within each group, so typing never reshuffles the strip', () => {
    const strip = chipStrip([face(9), face(4)], [face(8), face(2)], 9)
    expect(strip.chips.map((c) => c.clientId)).toEqual([2, 8, 4, 9])
  })
})
