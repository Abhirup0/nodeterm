import { describe, it, expect } from 'vitest'
import { effectiveSize } from './pty-size'
import { IPC } from '../shared/ipc'

describe('effectiveSize', () => {
  it('is the subscriber s own size when there is exactly one (single-user path)', () => {
    expect(effectiveSize([{ cols: 120, rows: 40 }])).toEqual({ cols: 120, rows: 40 })
  })

  it('takes the smallest cols and the smallest rows independently', () => {
    // The narrow client and the short client can be different people.
    expect(
      effectiveSize([
        { cols: 120, rows: 24 },
        { cols: 80, rows: 60 }
      ])
    ).toEqual({ cols: 80, rows: 24 })
  })

  it('floors at 1 (node-pty throws on 0) and ignores non-finite sizes', () => {
    expect(effectiveSize([{ cols: 0, rows: 0 }])).toEqual({ cols: 1, rows: 1 })
    expect(effectiveSize([{ cols: 80, rows: 24 }, { cols: NaN, rows: 10 }])).toEqual({
      cols: 80,
      rows: 10
    })
  })

  it('returns null for an empty subscriber set', () => {
    expect(effectiveSize([])).toBeNull()
  })
})

describe('per-session channels', () => {
  it('exposes the authoritative-size and closed channels', () => {
    expect(IPC.ptySize('pty-1')).toBe('pty:size:pty-1')
    expect(IPC.ptyClosed('pty-1')).toBe('pty:closed:pty-1')
  })
})
