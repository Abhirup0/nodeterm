import { describe, expect, it } from 'vitest'
import {
  UI_SCALE_CHOICES,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  resolveUiScale,
  uiScaleLabel
} from './ui-scale'
import { DEFAULT_SETTINGS } from './types'

describe('resolveUiScale', () => {
  it('answers 100% for every non-numeric value (settings.json is hand-editable)', () => {
    expect(resolveUiScale(undefined)).toBe(1) // every pre-feature settings.json
    expect(resolveUiScale(null)).toBe(1)
    expect(resolveUiScale('1.5')).toBe(1)
    expect(resolveUiScale(NaN)).toBe(1)
    expect(resolveUiScale(Infinity)).toBe(1)
    expect(resolveUiScale({})).toBe(1)
  })

  it('passes in-range values through unchanged, including hand-edited between-step values', () => {
    for (const c of UI_SCALE_CHOICES) expect(resolveUiScale(c)).toBe(c)
    expect(resolveUiScale(1.15)).toBe(1.15)
  })

  it('clamps out-of-range numbers instead of letting them break the window', () => {
    expect(resolveUiScale(0.01)).toBe(UI_SCALE_MIN)
    expect(resolveUiScale(50)).toBe(UI_SCALE_MAX)
    expect(resolveUiScale(-2)).toBe(UI_SCALE_MIN)
  })
})

describe('UI_SCALE_CHOICES', () => {
  it('are ascending, start at 100%, and sit inside the clamp range', () => {
    expect(UI_SCALE_CHOICES[0]).toBe(1)
    for (let i = 1; i < UI_SCALE_CHOICES.length; i++)
      expect(UI_SCALE_CHOICES[i]).toBeGreaterThan(UI_SCALE_CHOICES[i - 1])
    for (const c of UI_SCALE_CHOICES) expect(resolveUiScale(c)).toBe(c)
  })
})

describe('uiScaleLabel', () => {
  it('renders whole percentages', () => {
    expect(uiScaleLabel(1)).toBe('100%')
    expect(uiScaleLabel(1.1)).toBe('110%')
    expect(uiScaleLabel(1.25)).toBe('125%')
    expect(uiScaleLabel(2)).toBe('200%')
  })
})

describe('DEFAULT_SETTINGS.uiScale', () => {
  it('is 100% — an upgrade must not rescale anyone who never asked', () => {
    expect(DEFAULT_SETTINGS.uiScale).toBe(1)
    expect(resolveUiScale(DEFAULT_SETTINGS.uiScale)).toBe(1)
  })
})
