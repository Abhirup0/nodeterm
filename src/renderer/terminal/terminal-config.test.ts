import { describe, it, expect } from 'vitest'
import {
  closedByLabel,
  isLetterboxed,
  reportedSize,
  shouldApplyResync,
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
