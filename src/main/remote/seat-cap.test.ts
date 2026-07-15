import { describe, it, expect } from 'vitest'
import { canAcceptSeat } from './seat-cap'

describe('canAcceptSeat', () => {
  it('admits when live peers are below the seat cap', () => {
    expect(canAcceptSeat(0, 1)).toBe(true)
    expect(canAcceptSeat(2, 3)).toBe(true)
  })

  it('refuses when the cap is reached', () => {
    expect(canAcceptSeat(1, 1)).toBe(false)
    expect(canAcceptSeat(3, 3)).toBe(false)
  })

  it('refuses every seat when the cap is 0 (free / no entitlement)', () => {
    expect(canAcceptSeat(0, 0)).toBe(false)
  })
})
