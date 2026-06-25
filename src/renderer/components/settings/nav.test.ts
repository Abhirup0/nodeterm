import { describe, it, expect } from 'vitest'
import { SETTINGS_GROUPS, allSectionIds, FIRST_SECTION_ID } from './nav'

describe('SETTINGS_GROUPS', () => {
  it('lists exactly 14 sections with no duplicates', () => {
    const ids = allSectionIds()
    expect(ids).toHaveLength(14)
    expect(new Set(ids).size).toBe(14)
  })
  it('starts at a section that exists in the groups', () => {
    expect(allSectionIds()).toContain(FIRST_SECTION_ID)
  })
})
