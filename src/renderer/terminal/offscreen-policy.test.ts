import { describe, it, expect } from 'vitest'
import { OFFSCREEN_DISPOSE_MS_DEFAULT, offscreenDisposeMs, mayDisposeOffscreen } from './offscreen-policy'

describe('offscreen dispose policy', () => {
  it('default is 10 minutes; 0 disables; undefined falls back to default', () => {
    expect(OFFSCREEN_DISPOSE_MS_DEFAULT).toBe(600_000)
    expect(offscreenDisposeMs(undefined)).toBe(600_000)
    expect(offscreenDisposeMs(10)).toBe(600_000)
    expect(offscreenDisposeMs(0)).toBeNull()
    expect(offscreenDisposeMs(-3)).toBeNull()
    expect(offscreenDisposeMs(2)).toBe(120_000)
  })
  it('never disposes a visible, selected, or remote terminal', () => {
    expect(mayDisposeOffscreen({ visible: false, remote: false, selected: false })).toBe(true)
    expect(mayDisposeOffscreen({ visible: true, remote: false, selected: false })).toBe(false)
    expect(mayDisposeOffscreen({ visible: false, remote: true, selected: false })).toBe(false)
    expect(mayDisposeOffscreen({ visible: false, remote: false, selected: true })).toBe(false)
  })
})
