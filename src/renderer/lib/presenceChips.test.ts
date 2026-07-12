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
      { clientId: 8, letter: 'A', color: '#ff9f0a', title: 'ada is here' },
      { clientId: 9, letter: 'B', color: '#5ac8fa', title: 'Bo is here' }
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
    const strip = chipStrip([face(1), face(2), face(3)], 3)
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
