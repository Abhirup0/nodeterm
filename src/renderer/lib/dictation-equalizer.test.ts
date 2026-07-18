import { describe, expect, it } from 'vitest'
import { EQUALIZER_BAR_COUNT, EQUALIZER_IDLE_FLOOR, equalizerBars } from './dictation-equalizer'

describe('equalizerBars', () => {
  it('pads an empty history with the idle floor, at the default bar count', () => {
    const bars = equalizerBars([])
    expect(bars).toHaveLength(EQUALIZER_BAR_COUNT)
    expect(bars.every((h) => h === EQUALIZER_IDLE_FLOOR)).toBe(true)
  })

  it('left-pads a short history and keeps sample order (most-recent last)', () => {
    const bars = equalizerBars([0.5, 0.9], 5, 0.1)
    expect(bars).toEqual([0.1, 0.1, 0.1, 0.5, 0.9])
  })

  it('keeps only the most recent barCount samples when history overflows', () => {
    const history = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
    expect(equalizerBars(history, 3, 0)).toEqual([0.4, 0.5, 0.6])
  })

  it('clamps out-of-range samples into [0,1]', () => {
    expect(equalizerBars([-5, 5], 2, 0)).toEqual([0, 1])
  })

  it('floors every bar (including clamped/def NaN samples) at idleFloor', () => {
    expect(equalizerBars([0, 0.02, Number.NaN], 3, 0.08)).toEqual([0.08, 0.08, 0.08])
  })

  it('treats non-finite samples as 0 before flooring', () => {
    expect(equalizerBars([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY], 2, 0.1)).toEqual([
      0.1, 0.1
    ])
  })

  it('is a no-op passthrough (modulo floor/clamp) when history already equals barCount', () => {
    const history = [0.1, 0.2, 0.3]
    expect(equalizerBars(history, 3, 0)).toEqual(history)
  })
})
