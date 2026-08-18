import { describe, expect, it, vi } from 'vitest'
import { applyIconChoice } from './nodeIconChoice'

describe('applyIconChoice', () => {
  it('sets the chosen icon', () => {
    const apply = vi.fn()
    applyIconChoice({ type: 'emoji', value: '\u{1F680}' }, apply)
    expect(apply).toHaveBeenCalledWith({ type: 'emoji', value: '\u{1F680}' })
  })

  // The distinction the whole module exists for: `if (!choice) return` passes every test above
  // and breaks exactly this one.
  it('clears the icon on remove', () => {
    const apply = vi.fn()
    applyIconChoice(null, apply)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(undefined)
  })

  it('does nothing at all on cancel, so a cancel cannot mark the canvas dirty', () => {
    const apply = vi.fn()
    applyIconChoice(undefined, apply)
    expect(apply).not.toHaveBeenCalled()
  })
})
