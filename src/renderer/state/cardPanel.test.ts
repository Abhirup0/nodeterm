import { describe, it, expect } from 'vitest'
import { parseCardPanelOpen, useCardPanel } from './cardPanel'

describe('parseCardPanelOpen', () => {
  it('defaults to open, remembers only an explicit close', () => {
    expect(parseCardPanelOpen(null)).toBe(true)
    expect(parseCardPanelOpen('true')).toBe(true)
    expect(parseCardPanelOpen('garbage')).toBe(true)
    expect(parseCardPanelOpen('false')).toBe(false)
  })
})

describe('toggle', () => {
  it('flips the panel and keeps the flag in the store', () => {
    expect(useCardPanel.getState().open).toBe(true)
    useCardPanel.getState().toggle()
    expect(useCardPanel.getState().open).toBe(false)
    useCardPanel.getState().toggle()
    expect(useCardPanel.getState().open).toBe(true)
  })
})
