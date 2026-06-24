import { describe, it, expect } from 'vitest'
import { matchesQuery } from './search'

describe('matchesQuery', () => {
  it('matches everything when the query is empty or whitespace', () => {
    expect(matchesQuery('', { title: 'Font size' })).toBe(true)
    expect(matchesQuery('   ', { title: 'Font size' })).toBe(true)
  })
  it('matches the title case-insensitively', () => {
    expect(matchesQuery('FONT', { title: 'Font size' })).toBe(true)
  })
  it('matches the description', () => {
    expect(matchesQuery('blink', { title: 'Cursor', description: 'Cursor blink' })).toBe(true)
  })
  it('matches a keyword not present in the title', () => {
    expect(matchesQuery('typeface', { title: 'Font family', keywords: ['typeface'] })).toBe(true)
  })
  it('returns false when nothing matches', () => {
    expect(matchesQuery('zzz', { title: 'Font size', keywords: ['font'] })).toBe(false)
  })
})
