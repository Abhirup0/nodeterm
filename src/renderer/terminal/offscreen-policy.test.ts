import { describe, it, expect } from 'vitest'
import {
  OFFSCREEN_DISPOSE_MS_DEFAULT,
  offscreenDisposeMs,
  mayDisposeOffscreen,
  planOffscreenVisibility
} from './offscreen-policy'

describe('offscreen dispose policy', () => {
  it('default is 10 minutes; 0 disables; undefined falls back to default', () => {
    expect(OFFSCREEN_DISPOSE_MS_DEFAULT).toBe(600_000)
    expect(offscreenDisposeMs(undefined)).toBe(600_000)
    expect(offscreenDisposeMs(10)).toBe(600_000)
    expect(offscreenDisposeMs(0)).toBeNull()
    expect(offscreenDisposeMs(-3)).toBeNull()
    expect(offscreenDisposeMs(2)).toBe(120_000)
  })
  it('never disposes a visible, selected, or remote terminal', () => {
    expect(mayDisposeOffscreen({ visible: false, remote: false, selected: false })).toBe(true)
    expect(mayDisposeOffscreen({ visible: true, remote: false, selected: false })).toBe(false)
    expect(mayDisposeOffscreen({ visible: false, remote: true, selected: false })).toBe(false)
    expect(mayDisposeOffscreen({ visible: false, remote: false, selected: true })).toBe(false)
  })
})

describe('planOffscreenVisibility', () => {
  const ms = 600_000
  it('arms the timer once when a live terminal goes offscreen', () => {
    expect(
      planOffscreenVisibility({ visible: false, down: false, timerArmed: false, disposeMs: ms })
    ).toEqual({ cancelTimer: false, armTimer: true, revive: false })
  })
  it('never re-arms while a timer is already armed (a pan fires the observer repeatedly)', () => {
    expect(
      planOffscreenVisibility({ visible: false, down: false, timerArmed: true, disposeMs: ms })
    ).toEqual({ cancelTimer: false, armTimer: false, revive: false })
  })
  it('arms nothing while already down, and nothing when the feature is off', () => {
    expect(
      planOffscreenVisibility({ visible: false, down: true, timerArmed: false, disposeMs: ms })
    ).toEqual({ cancelTimer: false, armTimer: false, revive: false })
    expect(
      planOffscreenVisibility({ visible: false, down: false, timerArmed: false, disposeMs: null })
    ).toEqual({ cancelTimer: false, armTimer: false, revive: false })
  })
  it('cancels an armed timer the moment the node is visible again', () => {
    expect(
      planOffscreenVisibility({ visible: true, down: false, timerArmed: true, disposeMs: ms })
    ).toEqual({ cancelTimer: true, armTimer: false, revive: false })
  })
  it('revives a downed node on visibility — even with the feature switched off meanwhile', () => {
    expect(
      planOffscreenVisibility({ visible: true, down: true, timerArmed: false, disposeMs: ms })
    ).toEqual({ cancelTimer: false, armTimer: false, revive: true })
    expect(
      planOffscreenVisibility({ visible: true, down: true, timerArmed: false, disposeMs: null })
    ).toEqual({ cancelTimer: false, armTimer: false, revive: true })
  })
  it('a visible node with nothing pending owes nothing', () => {
    expect(
      planOffscreenVisibility({ visible: true, down: false, timerArmed: false, disposeMs: ms })
    ).toEqual({ cancelTimer: false, armTimer: false, revive: false })
  })
})
