import { describe, it, expect } from 'vitest'
import { HUD_ROW_CAP, overflowLabel, splitPanelRows, type PanelRow } from './panel-rows'

const row = (state: PanelRow['state'], unread = false): PanelRow => ({ state, unread })

describe('splitPanelRows', () => {
  it('draws the first HUD_ROW_CAP rows and hands the rest back as hidden', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ id: i }))
    const { shown, hidden } = splitPanelRows(rows)
    expect(shown).toHaveLength(HUD_ROW_CAP)
    expect(hidden).toHaveLength(9 - HUD_ROW_CAP)
    // Order is the caller's ranking, untouched on both sides — re-sorting here would be the very
    // churn the ranking exists to stop.
    expect([...shown, ...hidden]).toEqual(rows)
  })

  it('hides nothing when the list fits', () => {
    const rows = [row('needsYou'), row('working')]
    const { shown, hidden } = splitPanelRows(rows)
    expect(shown).toEqual(rows)
    expect(hidden).toEqual([])
    expect(overflowLabel(hidden)).toBeUndefined()
  })

  it('honors an explicit cap (the "show all" expansion passes rows.length)', () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({ id: i }))
    expect(splitPanelRows(rows, rows.length).hidden).toEqual([])
    expect(splitPanelRows(rows, 2).shown).toEqual([{ id: 0 }, { id: 1 }])
  })
})

describe('overflowLabel', () => {
  it('counts what the cap left out, by tier, in tier order', () => {
    const hidden = [
      row('needsYou'),
      row('done', true),
      row('done', true),
      row('working'),
      row('working'),
      row('working')
    ]
    expect(overflowLabel(hidden)).toBe('+6 more · 1 needs you · 2 unread · 3 running')
  })

  it('omits empty tiers rather than printing zeroes', () => {
    expect(overflowLabel([row('working'), row('working')])).toBe('+2 more · 2 running')
    expect(overflowLabel([row('done', true)])).toBe('+1 more · 1 unread')
  })

  it('counts a read `done` as idle, not as unread', () => {
    expect(overflowLabel([row('done', false), row('idle')])).toBe('+2 more · 2 idle')
  })
})
