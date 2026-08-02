import { describe, it, expect } from 'vitest'
import { freeSpot, type Box } from './placement'

const size = { w: 100, h: 100 }

describe('freeSpot', () => {
  it('returns the preferred spot on an empty canvas', () => {
    expect(freeSpot([], { x: 0, y: 0 }, size)).toEqual({ x: 0, y: 0 })
  })

  it('returns the preferred spot when it does not overlap anything', () => {
    const existing: Box[] = [{ x: 500, y: 500, w: 100, h: 100 }]
    expect(freeSpot(existing, { x: 0, y: 0 }, size)).toEqual({ x: 0, y: 0 })
  })

  it('moves the node off an occupied spot to a nearby clear one', () => {
    const existing: Box[] = [{ x: 0, y: 0, w: 100, h: 100 }]
    const spot = freeSpot(existing, { x: 0, y: 0 }, size)
    expect(spot).not.toEqual({ x: 0, y: 0 })
    // the chosen spot must not overlap the occupied box (with the default gap)
    const overlaps = spot.x < 128 && spot.x + 128 > 0 && spot.y < 128 && spot.y + 128 > 0
    expect(overlaps).toBe(false)
  })

  it('respects the gap: an adjacent-but-too-close spot is rejected, a spot a full step away is taken', () => {
    // One box at origin; the first clear cell is a full (size+gap) step out.
    const existing: Box[] = [{ x: 0, y: 0, w: 100, h: 100 }]
    const spot = freeSpot(existing, { x: 0, y: 0 }, size, 28)
    // nearest ring cell is 128px away on an axis
    expect(Math.max(Math.abs(spot.x), Math.abs(spot.y))).toBe(128)
  })

  it('finds a hole in a packed grid rather than piling on', () => {
    // Fill a 3x3 grid around origin EXCEPT the center; preferred=center → it should stay (clear),
    // so instead leave the center occupied and a hole at (128,0).
    const step = 128
    const existing: Box[] = []
    for (let gx = -1; gx <= 1; gx++)
      for (let gy = -1; gy <= 1; gy++)
        if (!(gx === 1 && gy === 0)) existing.push({ x: gx * step, y: gy * step, w: 100, h: 100 })
    const spot = freeSpot(existing, { x: 0, y: 0 }, size)
    expect(spot).toEqual({ x: 128, y: 0 }) // the one hole
  })

  it('never overlaps any existing node across a dense fill', () => {
    const existing: Box[] = []
    for (let i = 0; i < 20; i++) existing.push({ x: (i % 5) * 128, y: Math.floor(i / 5) * 128, w: 100, h: 100 })
    const spot = freeSpot(existing, { x: 0, y: 0 }, size)
    const clear = !existing.some(
      (b) => spot.x < b.x + b.w + 28 && spot.x + 128 > b.x && spot.y < b.y + b.h + 28 && spot.y + 128 > b.y
    )
    expect(clear).toBe(true)
  })
})
