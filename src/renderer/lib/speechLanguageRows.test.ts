import { describe, expect, it } from 'vitest'
import {
  moveRow,
  speechLanguageRows,
  speechLanguageSummary,
  speechLanguageWarning
} from './speechLanguageRows'

const codes = (q: string, current = 'auto'): string[] =>
  speechLanguageRows(q, current).map((r) => r.code)

describe('speechLanguageRows', () => {
  it('pins Auto-detect above the catalogue when nothing is typed', () => {
    const rows = speechLanguageRows('', 'auto')
    expect(rows[0]).toMatchObject({ code: 'auto', label: 'Auto-detect' })
    expect(rows).toHaveLength(101) // auto + whisper's 100
  })

  it('does not let Auto-detect outrank what the user is clearly typing', () => {
    // "de" is a substring of "auto-detect"; a `.includes` match would have pinned Auto-detect
    // above German for it.
    expect(codes('de')[0]).toBe('de')
    expect(codes('de')).not.toContain('auto')
    // It is still reachable by its own name.
    expect(codes('au')[0]).toBe('auto')
    expect(codes('detect')).toEqual(['auto'])
  })

  it('finds Polish by code, English name and endonym', () => {
    expect(codes('pl')[0]).toBe('pl')
    expect(codes('polish')[0]).toBe('pl')
    expect(codes('polski')[0]).toBe('pl')
  })

  it('keeps a stored code the catalogue does not know selectable', () => {
    // The state that used to render blank and get overwritten on the next click.
    const rows = speechLanguageRows('', 'xx-custom')
    expect(rows[1]).toMatchObject({ code: 'xx-custom', label: 'xx-custom' })
    expect(codes('xx', 'xx-custom')).toContain('xx-custom')
    // A known code never gets the extra row.
    expect(speechLanguageRows('', 'pl').filter((r) => r.code === 'pl')).toHaveLength(1)
  })

  it('shows the endonym and code, and drops an endonym that only repeats the label', () => {
    const pl = speechLanguageRows('pl', 'auto').find((r) => r.code === 'pl')
    expect(pl?.hint).toBe('polski · pl')
    const la = speechLanguageRows('latin', 'auto').find((r) => r.code === 'la')
    expect(la?.hint).toBe('la')
  })
})

describe('moveRow', () => {
  it('wraps in both directions and survives an empty list', () => {
    expect(moveRow(0, 1, 3)).toBe(1)
    expect(moveRow(2, 1, 3)).toBe(0)
    expect(moveRow(0, -1, 3)).toBe(2)
    expect(moveRow(0, 1, 0)).toBe(0)
    expect(moveRow(0, -1, 0)).toBe(0)
  })
})

describe('speechLanguageSummary', () => {
  it('names the selected language, with its endonym when that adds something', () => {
    expect(speechLanguageSummary('pl')).toBe('Transcribing as Polish (polski).')
    expect(speechLanguageSummary('la')).toBe('Transcribing as Latin.')
    expect(speechLanguageSummary('xx')).toBe('Transcribing as “xx”.')
    expect(speechLanguageSummary('auto')).toMatch(/^Auto-detect: /)
  })
})

describe('speechLanguageWarning', () => {
  it('says nothing for an ordinary pairing', () => {
    expect(speechLanguageWarning('auto', 'tiny')).toBeUndefined()
    expect(speechLanguageWarning('pl', 'tiny')).toBeUndefined()
    expect(speechLanguageWarning('yue', 'large-v3-turbo')).toBeUndefined()
  })

  it('flags a code this build cannot name, without suggesting it was dropped', () => {
    const w = speechLanguageWarning('xx', 'tiny')
    expect(w).toContain('kept exactly as set')
  })

  it('flags Cantonese under a pre-large-v3 model, but not while dictation is off', () => {
    expect(speechLanguageWarning('yue', 'small')).toContain('large-v3')
    expect(speechLanguageWarning('yue', '')).toBeUndefined()
  })
})
