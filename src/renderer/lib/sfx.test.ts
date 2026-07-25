import { describe, it, expect } from 'vitest'
import { sfxScore } from './sfx'

describe('sfxScore', () => {
  it('done is a short rising arpeggio of tones', () => {
    const s = sfxScore('done')
    expect(s.length).toBeGreaterThanOrEqual(3)
    expect(s.every((v) => v.kind === 'tone')).toBe(true)
    // Strictly rising — that's what makes it read as "finished" rather than "alert".
    for (let i = 1; i < s.length; i++) expect(s[i].freq).toBeGreaterThan(s[i - 1].freq)
    // Voices are scheduled in order and the whole effect is brief.
    for (let i = 1; i < s.length; i++) expect(s[i].at).toBeGreaterThanOrEqual(s[i - 1].at)
    expect(Math.max(...s.map((v) => v.at + v.dur))).toBeLessThan(0.4)
  })

  it('needsYou mixes a noise crackle with falling tones', () => {
    const s = sfxScore('needsYou')
    expect(s.some((v) => v.kind === 'noise')).toBe(true)
    const tones = s.filter((v) => v.kind === 'tone')
    expect(tones.length).toBeGreaterThan(0)
    // Falling — the opposite gesture to `done`, so the two are distinguishable by ear alone.
    for (const t of tones) expect(t.freqTo!).toBeLessThan(t.freq)
    expect(Math.max(...s.map((v) => v.at + v.dur))).toBeLessThan(0.4)
  })

  it('keeps every voice inside the relative gain range', () => {
    for (const kind of ['done', 'needsYou'] as const)
      for (const v of sfxScore(kind)) {
        expect(v.gain).toBeGreaterThan(0)
        expect(v.gain).toBeLessThanOrEqual(1)
        expect(v.dur).toBeGreaterThan(0)
      }
  })
})
