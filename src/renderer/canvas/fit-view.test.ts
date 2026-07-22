import { describe, expect, it } from 'vitest'
import { largestFreeRect, rectToPadding, rectsOverlap, type FitRect } from './fit-view'

/**
 * Geometry measured from a real 1264x722 canvas (see docs/superpowers/specs) — the chrome rects
 * are the actual dock / minimap / controls positions, already inflated by the gap.
 */
const VIEWPORT: FitRect = { left: 12, top: 56, right: 1252, bottom: 754 }
const DOCK: FitRect = { left: 407, top: 678, right: 858, bottom: 756 }
const MINIMAP: FitRect = { left: 1035, top: 587, right: 1261, bottom: 763 }
const CONTROLS: FitRect = { left: 3, top: 635, right: 53, bottom: 763 }
const CHROME = [DOCK, MINIMAP, CONTROLS]

const w = (r: FitRect): number => r.right - r.left
const h = (r: FitRect): number => r.bottom - r.top
const zoomOf = (r: FitRect, cw: number, ch: number): number => Math.min(w(r) / cw, h(r) / ch)

describe('largestFreeRect', () => {
  it('never returns a rect that overlaps any chrome', () => {
    for (const [cw, ch] of [
      [2000, 600],
      [300, 2000],
      [1000, 1000],
      [50, 50],
      [5000, 20]
    ]) {
      const r = largestFreeRect(VIEWPORT, CHROME, cw, ch)
      expect(r, `content ${cw}x${ch}`).not.toBeNull()
      for (const c of CHROME) expect(rectsOverlap(r!, c), `content ${cw}x${ch}`).toBe(false)
    }
  })

  it('stays inside the viewport', () => {
    const r = largestFreeRect(VIEWPORT, CHROME, 1000, 1000)!
    expect(r.left).toBeGreaterThanOrEqual(VIEWPORT.left)
    expect(r.top).toBeGreaterThanOrEqual(VIEWPORT.top)
    expect(r.right).toBeLessThanOrEqual(VIEWPORT.right)
    expect(r.bottom).toBeLessThanOrEqual(VIEWPORT.bottom)
  })

  it('does not charge narrow content for the bottom-right minimap', () => {
    // The regression this whole module exists for: a tall narrow column sits well clear of the
    // minimap's x-range, so it must be allowed to run past the minimap's top edge.
    const r = largestFreeRect(VIEWPORT, CHROME, 300, 2000)!
    expect(r.bottom).toBeGreaterThan(MINIMAP.top)
    expect(r.right).toBeLessThanOrEqual(MINIMAP.left)
  })

  it('beats a naive "reserve the deepest bottom intrusion" strategy for narrow content', () => {
    const naiveBottom = Math.min(DOCK.top, MINIMAP.top, CONTROLS.top)
    const naive: FitRect = { ...VIEWPORT, bottom: naiveBottom }
    const solved = largestFreeRect(VIEWPORT, CHROME, 300, 2000)!
    expect(zoomOf(solved, 300, 2000)).toBeGreaterThan(zoomOf(naive, 300, 2000))
  })

  it('uses the full width for wide content, stopping above the bottom chrome', () => {
    const r = largestFreeRect(VIEWPORT, CHROME, 4000, 500)!
    // Wide content genuinely spans the minimap's and controls' x-range, so it must clear them.
    expect(r.bottom).toBeLessThanOrEqual(Math.min(MINIMAP.top, CONTROLS.top))
    expect(w(r)).toBeGreaterThan(1000)
  })

  it('returns the whole viewport when nothing is in the way', () => {
    const r = largestFreeRect(VIEWPORT, [], 1000, 1000)!
    expect(r).toEqual(VIEWPORT)
  })

  it('reclaims space when chrome is hidden (fewer obstacles ⇒ at least as much zoom)', () => {
    const withAll = largestFreeRect(VIEWPORT, CHROME, 1200, 700)!
    const withoutMinimap = largestFreeRect(VIEWPORT, [DOCK, CONTROLS], 1200, 700)!
    expect(zoomOf(withoutMinimap, 1200, 700)).toBeGreaterThanOrEqual(zoomOf(withAll, 1200, 700))
  })

  it('is exhaustive: no sampled free rect beats the chosen one', () => {
    const cw = 900
    const ch = 800
    const best = largestFreeRect(VIEWPORT, CHROME, cw, ch)!
    const bestZoom = zoomOf(best, cw, ch)
    // Brute-force a grid of candidate rects; none may afford more zoom than the solver's. Track
    // the max and assert once — an expect() per candidate would be millions of calls.
    const step = 25
    let brute = 0
    for (let l = VIEWPORT.left; l < VIEWPORT.right; l += step) {
      for (let r2 = l + step; r2 <= VIEWPORT.right; r2 += step) {
        for (let t = VIEWPORT.top; t < VIEWPORT.bottom; t += step) {
          for (let b = t + step; b <= VIEWPORT.bottom; b += step) {
            const cand: FitRect = { left: l, right: r2, top: t, bottom: b }
            if (CHROME.some((c) => rectsOverlap(c, cand))) continue
            const z = zoomOf(cand, cw, ch)
            if (z > brute) brute = z
          }
        }
      }
    }
    expect(brute).toBeLessThanOrEqual(bestZoom + 1e-6)
  })

  it('guards degenerate content', () => {
    expect(largestFreeRect(VIEWPORT, CHROME, 0, 100)).toBeNull()
    expect(largestFreeRect(VIEWPORT, CHROME, 100, 0)).toBeNull()
  })
})

describe('rectToPadding', () => {
  it('converts a chosen rect into per-side px insets', () => {
    const outer: FitRect = { left: 0, top: 0, right: 1000, bottom: 800 }
    expect(rectToPadding(outer, { left: 20, top: 30, right: 900, bottom: 700 })).toEqual({
      left: '20px',
      top: '30px',
      right: '100px',
      bottom: '100px'
    })
  })

  it('never emits negative padding', () => {
    const outer: FitRect = { left: 0, top: 0, right: 100, bottom: 100 }
    expect(rectToPadding(outer, { left: -10, top: -10, right: 110, bottom: 110 })).toEqual({
      left: '0px',
      top: '0px',
      right: '0px',
      bottom: '0px'
    })
  })
})
