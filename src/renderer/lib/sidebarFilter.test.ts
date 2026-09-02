import { describe, it, expect } from 'vitest'
import { sidebarEmptyState, sidebarFilterKeyAction } from './sidebarFilter'

describe('sidebarFilterKeyAction — Escape clears the filter (issue #505)', () => {
  it('clears in one action while the field holds text', () => {
    expect(sidebarFilterKeyAction('Escape', 'api')).toBe('clear')
  })

  it('leaves Escape alone on an empty field, so the key is never a dead end here', () => {
    expect(sidebarFilterKeyAction('Escape', '')).toBe('ignore')
  })

  it('ignores every other key', () => {
    expect(sidebarFilterKeyAction('Enter', 'api')).toBe('ignore')
    expect(sidebarFilterKeyAction('a', 'api')).toBe('ignore')
    expect(sidebarFilterKeyAction('Backspace', 'api')).toBe('ignore')
  })
})

describe('sidebarEmptyState — "nothing matched" is not "nothing here"', () => {
  it('says nothing while the list has rows', () => {
    expect(sidebarEmptyState(false, '', 'project')).toBe('none')
    expect(sidebarEmptyState(false, 'api', 'project')).toBe('none')
    expect(sidebarEmptyState(false, 'api', 'status')).toBe('none')
  })

  it('reports no-matches in BOTH grouping modes when a filter is active', () => {
    expect(sidebarEmptyState(true, 'api', 'project')).toBe('no-matches')
    // Status mode renders only non-empty sections, so this used to be a blank panel with no
    // sentence at all — the case that read as "no sessions".
    expect(sidebarEmptyState(true, 'api', 'status')).toBe('no-matches')
  })

  it('treats a whitespace-only filter as no filter (it matches everything)', () => {
    expect(sidebarEmptyState(true, '   ', 'project')).toBe('no-sessions')
  })

  it('keeps the unfiltered empty state exactly where it was: project mode only', () => {
    expect(sidebarEmptyState(true, '', 'project')).toBe('no-sessions')
    expect(sidebarEmptyState(true, '', 'status')).toBe('none')
  })
})
