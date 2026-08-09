import { describe, expect, it } from 'vitest'
import { atlasFilterChoice } from './gl-webgl2'

/**
 * The 2026-08-09 report — "the terminal text isn't so crisp, which might be related to retina
 * displays" — measured. The reporting canvas was at **0.976**, and the rule jumped to trilinear
 * mip filtering the instant zoom fell below 1: a half-resolution mip blended into every glyph to
 * pay for a 2.4% minification. GPU per terminal looked sharper because xterm draws 1:1 and the
 * browser's compositor does the 0.976 in one pass.
 *
 * A canvas is very rarely at exactly 1 — any pinch, fitView or window resize lands on a number
 * like that — so the near-1 band is where most users actually sit, not an edge case.
 */
describe('atlasFilterChoice', () => {
  it('samples level 0 alone just below 1 — the case the report was taken at', () => {
    expect(atlasFilterChoice(0.976135).min).toBe('linear')
    expect(atlasFilterChoice(0.95).min).toBe('linear')
    expect(atlasFilterChoice(0.9).min).toBe('linear')
  })

  it('keeps bit-exact NEAREST at and above 1', () => {
    expect(atlasFilterChoice(1).min).toBe('nearest')
    expect(atlasFilterChoice(1.5).min).toBe('nearest')
  })

  it('still reaches for the mip chain on a GENUINE zoom-out', () => {
    // This is what the chain is for: at 0.5 or 0.3 several texels really do land in one pixel, and
    // level 0 alone undersamples into shimmer.
    expect(atlasFilterChoice(0.85).min).toBe('trilinear')
    expect(atlasFilterChoice(0.5).min).toBe('trilinear')
    expect(atlasFilterChoice(0.1).min).toBe('trilinear')
  })

  it('leaves the magnification rule alone', () => {
    // Unchanged from the 2026-08-04 parity call: 1 is on the crisp side, above it LINEAR matches
    // the bilinear upscale GPU mode gets from its CSS transform.
    expect(atlasFilterChoice(1).mag).toBe('nearest')
    expect(atlasFilterChoice(0.976).mag).toBe('nearest')
    expect(atlasFilterChoice(1.0001).mag).toBe('linear')
  })
})
