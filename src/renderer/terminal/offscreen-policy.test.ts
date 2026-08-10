import { describe, it, expect } from 'vitest'
import {
  OFFSCREEN_DISPOSE_MS_DEFAULT,
  offscreenDisposeMs,
  mayDisposeOffscreen,
  offscreenCoreIsRemote,
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
  // The second link in "a relay-sourced node never disposes": this predicate answers `true`, and
  // the row above proves `remote: true` refuses. Pinned as a test rather than as a comment because
  // the first attempt at this gate read a node field (`data.remote`) that is only ever set on a
  // PROJECT — a constant `false` that no type could catch and no test then covered.
  it('a session whose core is on another machine is remote; both local surfaces are not', () => {
    expect(offscreenCoreIsRemote('relay')).toBe(true)
    expect(offscreenCoreIsRemote('server')).toBe(true)
    // Electron's own session AND the Server Edition's browser session: the core is at the other end
    // of a preload / a same-machine socket, up whenever the UI is.
    expect(offscreenCoreIsRemote('local')).toBe(false)
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
  // The sequence a real node walks, driven the way the (mount-stable) observer drives it. Its
  // point is the LAST step: the revive is decided from `down` + `visible` alone — no armed timer,
  // no live setting, nothing that the down transition consumed. Which is also why the observer
  // that delivers that last verdict may not be owned by the effect the dispose tears down.
  it('walks hidden → armed → down → visible → revived', () => {
    let down = false
    let timerArmed = false
    const step = (visible: boolean): void => {
      const p = planOffscreenVisibility({ visible, down, timerArmed, disposeMs: ms })
      if (p.cancelTimer) timerArmed = false
      if (p.armTimer) timerArmed = true
      if (p.revive) down = false
    }
    step(false)
    expect(timerArmed).toBe(true)
    step(false) // a pan keeps reporting hidden; the deadline must not move
    expect(timerArmed).toBe(true)
    // …the timer fires: the node goes down and the timer is spent.
    timerArmed = false
    down = true
    step(true)
    expect(down).toBe(false)
    expect(timerArmed).toBe(false)
  })
  it('a visible node with nothing pending owes nothing', () => {
    expect(
      planOffscreenVisibility({ visible: true, down: false, timerArmed: false, disposeMs: ms })
    ).toEqual({ cancelTimer: false, armTimer: false, revive: false })
  })
})
