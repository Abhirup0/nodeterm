import { describe, expect, it } from 'vitest'
import {
  WheelZoomBurstLimiter,
  clampWheelZoomSpeed,
  nextWheelZoom,
  WHEEL_ZOOM_MAX_STEP
} from './wheel-zoom'

describe('WheelZoomBurstLimiter', () => {
  it('passes a small single packet through unchanged', () => {
    const limiter = new WheelZoomBurstLimiter()
    expect(limiter.apply(30, 1000)).toBe(30)
    expect(limiter.apply(-12.5, 2000)).toBe(-12.5)
  })

  it('clamps one oversized packet to the per-burst budget, preserving direction', () => {
    const limiter = new WheelZoomBurstLimiter()
    expect(limiter.apply(300, 1000)).toBe(WHEEL_ZOOM_MAX_STEP)
    expect(limiter.apply(-300, 2000)).toBe(-WHEEL_ZOOM_MAX_STEP)
  })

  it('shares one budget across a high-res detent burst (the MX Master jump)', () => {
    // An MX Master 3s detent arrives as several packets a few ms apart. Before the limiter,
    // each packet was clamped independently, so one physical click stacked two+ maxed zoom
    // steps (the observed 200% -> 84%). The whole burst must spend one budget.
    const limiter = new WheelZoomBurstLimiter()
    expect(limiter.apply(120, 1000)).toBe(WHEEL_ZOOM_MAX_STEP)
    expect(limiter.apply(120, 1004)).toBe(0)
    expect(limiter.apply(120, 1012)).toBe(0)
  })

  it('splits the budget across packets that only together exceed it', () => {
    const limiter = new WheelZoomBurstLimiter()
    expect(limiter.apply(35, 1000)).toBe(35)
    expect(limiter.apply(35, 1005)).toBe(WHEEL_ZOOM_MAX_STEP - 35)
  })

  it('refills the budget once the burst window has passed', () => {
    const limiter = new WheelZoomBurstLimiter()
    expect(limiter.apply(120, 1000)).toBe(WHEEL_ZOOM_MAX_STEP)
    expect(limiter.apply(120, 1050)).toBe(WHEEL_ZOOM_MAX_STEP)
  })

  it('leaves a smooth pinch stream untouched', () => {
    // Trackpad pinch: small deltas at ~120Hz. Must not be throttled — the limiter exists for
    // discrete wheel notches, and a pinch never spends the budget inside one window.
    const limiter = new WheelZoomBurstLimiter()
    const out: number[] = []
    for (let i = 0; i < 12; i++) out.push(limiter.apply(6, 1000 + i * 8))
    expect(out.every((d) => d === 6)).toBe(true)
  })

  it('a reversal inside an exhausted burst stays spent (no free counter-step)', () => {
    const limiter = new WheelZoomBurstLimiter()
    limiter.apply(120, 1000)
    expect(limiter.apply(-120, 1004)).toBe(0)
  })
})

describe('nextWheelZoom', () => {
  it('reproduces the historical step at speed 1', () => {
    expect(nextWheelZoom(1, 50, 1)).toBeCloseTo(Math.exp(-0.5), 10)
  })

  it('scales the exponent by the speed multiplier', () => {
    expect(nextWheelZoom(1, 50, 0.5)).toBeCloseTo(Math.exp(-0.25), 10)
    expect(nextWheelZoom(1, -25, 2)).toBeCloseTo(Math.exp(0.5), 10)
  })

  it('clamps to the canvas zoom bounds', () => {
    expect(nextWheelZoom(1.9, -50, 2)).toBe(2)
    expect(nextWheelZoom(0.011, 50, 2)).toBe(0.01)
  })
})

describe('clampWheelZoomSpeed', () => {
  it('passes sane values through and defaults the rest to 1', () => {
    expect(clampWheelZoomSpeed(0.5)).toBe(0.5)
    expect(clampWheelZoomSpeed(undefined)).toBe(1)
    expect(clampWheelZoomSpeed(Number.NaN)).toBe(1)
  })

  it('clamps hand-edited settings.json values into range', () => {
    expect(clampWheelZoomSpeed(0)).toBe(0.2)
    expect(clampWheelZoomSpeed(99)).toBe(2)
  })
})
