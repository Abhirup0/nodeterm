import { describe, it, expect, beforeEach } from 'vitest'
import {
  closedByLabel,
  forgetNodeTermState,
  isLetterboxed,
  letterboxFor,
  markRecycled,
  recycleAction,
  reportedSize,
  setFittedSize,
  shouldApplyResync,
  takeRecycled,
  toXtermText
} from './terminal-config'
import type { ClientId } from '@shared/presence'

describe('reportedSize', () => {
  it('reports the fit proposal, floored at 1 (a collapsed node can propose 0)', () => {
    expect(reportedSize({ cols: 132, rows: 43 })).toEqual({ cols: 132, rows: 43 })
    expect(reportedSize({ cols: 0, rows: 0 })).toEqual({ cols: 1, rows: 1 })
  })

  it('returns null when the fit cannot be measured (hidden / zero-size node)', () => {
    expect(reportedSize(undefined)).toBeNull()
    expect(reportedSize(null)).toBeNull()
    expect(reportedSize({ cols: NaN, rows: 24 })).toBeNull()
    expect(reportedSize({ cols: 80, rows: Infinity })).toBeNull()
    expect(reportedSize({ cols: 80 })).toBeNull()
  })
})

describe('isLetterboxed', () => {
  it('is false for a solo user: the effective size IS their own fit', () => {
    expect(isLetterboxed({ cols: 100, rows: 30 }, { cols: 100, rows: 30 })).toBe(false)
  })

  it('is true when the pty runs at a smaller subscriber s grid', () => {
    expect(isLetterboxed({ cols: 80, rows: 30 }, { cols: 100, rows: 30 })).toBe(true)
    expect(isLetterboxed({ cols: 100, rows: 24 }, { cols: 100, rows: 30 })).toBe(true)
  })

  it('is false while our own fit is unknown (nothing to letterbox against)', () => {
    expect(isLetterboxed({ cols: 80, rows: 24 }, null)).toBe(false)
  })
})

describe('shouldApplyResync', () => {
  it('paints a non-empty capture', () => {
    expect(shouldApplyResync('$ ls\nfoo\n')).toBe(true)
  })

  it('IGNORES an empty/absent payload — a wrongly reset screen is unrecoverable', () => {
    expect(shouldApplyResync('')).toBe(false)
    expect(shouldApplyResync(null)).toBe(false)
    expect(shouldApplyResync(undefined)).toBe(false)
  })
})

describe('toXtermText', () => {
  it('turns tmux capture LFs into CRLFs, leaving existing CRLFs alone', () => {
    expect(toXtermText('a\nb')).toBe('a\r\nb')
    expect(toXtermText('a\r\nb')).toBe('a\r\nb')
  })
})

describe('closedByLabel', () => {
  const peers = { 7: { name: 'Ada' } } as Record<ClientId, { name: string }>

  it('names the peer who destroyed the node', () => {
    expect(closedByLabel(7 as ClientId, peers)).toBe('Ada')
  })

  it('degrades to a neutral label for an unattributed destroy or an unknown/departed peer', () => {
    expect(closedByLabel(null, peers)).toBe('another user')
    expect(closedByLabel(99 as ClientId, peers)).toBe('another user')
  })
})

// The fitted size is read by the pty:size listener, which is wired ONCE and SURVIVES a park
// (the terminal is adopted by a later mount with its listeners intact). It therefore may not
// live in the mounting effect's closure: after a park/adopt, the listener would keep measuring
// the letterbox against the PRE-PARK grid — so a co-viewer who parks, changes the font size and
// comes back gets a letterbox he shouldn't have (or loses one he should).
describe('fitted-size registry (survives a park, like the listeners that read it)', () => {
  beforeEach(() => forgetNodeTermState('n1'))

  it('measures the letterbox against the fit of the CURRENTLY mounted terminal', () => {
    // Mount A fits 120×40 and wires the pty:size listener.
    setFittedSize('n1', { cols: 120, rows: 40 })
    const onSize = (size: { cols: number; rows: number }): boolean => letterboxFor('n1', size)
    expect(onSize({ cols: 80, rows: 24 })).toBe(true) // a smaller co-viewer clamps us → letterbox

    // Park + adopt: the SAME listener lives on, but the user bumped the font size, so mount B
    // fits a smaller grid — which is now exactly the pty's size. No letterbox.
    setFittedSize('n1', { cols: 80, rows: 24 })
    expect(onSize({ cols: 80, rows: 24 })).toBe(false)
  })

  it('reports no letterbox for a node that has never reported a fit', () => {
    expect(letterboxFor('never-fitted', { cols: 80, rows: 24 })).toBe(false)
  })

  it('forgets a node on permanent deletion (a recycled node id must not inherit a stale fit)', () => {
    setFittedSize('n1', { cols: 200, rows: 60 })
    forgetNodeTermState('n1')
    expect(letterboxFor('n1', { cols: 80, rows: 24 })).toBe(false)
  })
})

// The "session restarted by another user" banner is armed when the recycle notice lands and must
// be CONSUMED by the spawn it belongs to — even when that spawn is abandoned (the node unmounted
// while create() was in flight). A flag left behind would print the banner on some unrelated
// mount hours later.
describe('recycle banner flag', () => {
  beforeEach(() => forgetNodeTermState('n1'))

  it('is consumed exactly once', () => {
    markRecycled('n1')
    expect(takeRecycled('n1')).toBe(true)
    expect(takeRecycled('n1')).toBe(false)
  })

  it('is false for a node that was never recycled', () => {
    expect(takeRecycled('n1')).toBe(false)
  })

  it('is dropped with the node (no stale banner on a much later mount)', () => {
    markRecycled('n1')
    forgetNodeTermState('n1')
    expect(takeRecycled('n1')).toBe(false)
  })
})

// The recycle notice carries whether a REPLACEMENT session is already live. Without one (the
// recycler crashed between the kill and the create), restarting would spawn `nt-<id>` from this
// client's own — stale — cwd, silently undoing the worktree move for everybody. So: only restart
// when there is something to restart onto.
describe('recycleAction', () => {
  it('restarts onto the replacement session when it is live', () => {
    expect(recycleAction({ ready: true })).toBe('restart')
  })

  it('ends the terminal (reopen to restart) when no replacement was ever registered', () => {
    expect(recycleAction({ ready: false })).toBe('ended')
  })

  it('treats a payload-less/legacy notice as "no replacement" (never spawn in a stale cwd)', () => {
    expect(recycleAction(undefined)).toBe('ended')
  })
})
