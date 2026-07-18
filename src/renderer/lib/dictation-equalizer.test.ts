import { describe, expect, it } from 'vitest'
import { EQUALIZER_BAR_COUNT, EQUALIZER_IDLE_FLOOR, equalizerBars, scaleLevel } from './dictation-equalizer'

describe('scaleLevel', () => {
  it('maps silence to 0 (the idle floor is applied by equalizerBars, not here)', () => {
    expect(scaleLevel(0)).toBe(0)
  })

  it('applies sqrt + gain so typical speech reads solidly mid-to-upper height', () => {
    // sqrt(0.1) * 2.5 ≈ 0.7906 — well above the floor, short of full.
    expect(scaleLevel(0.1)).toBeCloseTo(0.7906, 3)
  })

  it('reads a quiet take (~0.05 RMS) at around half height, not near the floor', () => {
    // sqrt(0.05) * 2.5 ≈ 0.559
    expect(scaleLevel(0.05)).toBeCloseTo(0.559, 2)
  })

  it('clamps loud/out-of-range input at full height', () => {
    expect(scaleLevel(1)).toBe(1)
    expect(scaleLevel(0.3)).toBe(1) // already past the point sqrt*gain saturates
    expect(scaleLevel(5)).toBe(1)
  })

  it('is NaN/infinity/negative safe — non-finite or negative input counts as 0', () => {
    expect(scaleLevel(Number.NaN)).toBe(0)
    expect(scaleLevel(-1)).toBe(0)
    expect(scaleLevel(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(scaleLevel(Number.POSITIVE_INFINITY)).toBe(0) // non-finite, same as NaN
  })
})

describe('equalizerBars', () => {
  it('pads an empty history with the idle floor, at the default bar count', () => {
    const bars = equalizerBars([])
    expect(bars).toHaveLength(EQUALIZER_BAR_COUNT)
    expect(bars.every((h) => h === EQUALIZER_IDLE_FLOOR)).toBe(true)
  })

  it('silence (level 0) still floors to a visible minimum, never a flat 0', () => {
    expect(equalizerBars([0], 1)).toEqual([EQUALIZER_IDLE_FLOOR])
    expect(EQUALIZER_IDLE_FLOOR).toBeGreaterThan(0)
  })

  it('typical speech (RMS ~0.1) reads solidly mid-height', () => {
    const [h] = equalizerBars([0.1], 1)
    expect(h).toBeGreaterThan(0.4)
    expect(h).toBeLessThan(0.9)
  })

  it('loud input (RMS 1.0) hits full height', () => {
    expect(equalizerBars([1], 1)).toEqual([1])
  })

  it('left-pads a short history and keeps sample order (most-recent last)', () => {
    const bars = equalizerBars([0, 1], 5, 0.1)
    // raw 0 → scaleLevel 0 → floored up to 0.1; raw 1 → scaleLevel 1 (unaffected by the floor)
    expect(bars).toEqual([0.1, 0.1, 0.1, 0.1, 1])
  })

  it('keeps only the most recent barCount samples when history overflows', () => {
    const history = [0, 0, 0, 0, 0, 1]
    expect(equalizerBars(history, 3, 0)).toEqual([0, 0, 1])
  })

  it('is NaN/out-of-range safe (non-finite/negative samples floor to idleFloor)', () => {
    expect(equalizerBars([Number.NaN, -5], 2, 0.08)).toEqual([0.08, 0.08])
  })

  it('is a passthrough at the extremes (0 and 1 map to themselves) when history equals barCount', () => {
    const history = [0, 1, 0]
    expect(equalizerBars(history, 3, 0)).toEqual(history)
  })
})
