import { describe, it, expect } from 'vitest'
import { focusTargetId } from './focusTarget'

describe('focusTargetId', () => {
  it('picks the selected terminal node', () => {
    expect(
      focusTargetId([
        { id: 'a', type: 'sticky', selected: true },
        { id: 'b', type: 'terminal', selected: true },
        { id: 'c', type: 'terminal' }
      ])
    ).toBe('b')
  })

  it('returns null when nothing focusable is selected — never falls back to an arbitrary node', () => {
    expect(focusTargetId([{ id: 'a', type: 'terminal' }])).toBeNull()
    expect(focusTargetId([{ id: 'a', type: 'group', selected: true }])).toBeNull()
    expect(focusTargetId([])).toBeNull()
  })

  it('first selected terminal wins on multi-selection', () => {
    expect(
      focusTargetId([
        { id: 'x', type: 'terminal', selected: true },
        { id: 'y', type: 'terminal', selected: true }
      ])
    ).toBe('x')
  })
})
