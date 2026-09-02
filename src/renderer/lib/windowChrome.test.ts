import { describe, expect, it } from 'vitest'
import { applyWindowChrome, hasInsetTrafficLights } from './windowChrome'

describe('hasInsetTrafficLights', () => {
  it('is true only on the macOS desktop app', () => {
    expect(hasInsetTrafficLights(true, false)).toBe(true)
  })

  // Issue #564: on Windows/Linux the controls live in a native title bar, so the tab bar's 86px
  // reservation was pure waste — the logo pushed in, the tab strip that much narrower.
  it('is false off macOS', () => {
    expect(hasInsetTrafficLights(false, false)).toBe(false)
  })

  // A Server Edition browser tab has no window controls of its own on ANY OS, macOS included.
  it('is false in a browser tab even on macOS', () => {
    expect(hasInsetTrafficLights(true, true)).toBe(false)
  })
})

describe('applyWindowChrome', () => {
  it('stamps the attribute only where the traffic lights are inset', () => {
    const root = { dataset: {} as Record<string, string | undefined> } as unknown as HTMLElement
    applyWindowChrome(root, true)
    expect(root.dataset.windowChrome).toBe('inset')
    applyWindowChrome(root, false)
    expect(root.dataset.windowChrome).toBeUndefined()
  })
})
