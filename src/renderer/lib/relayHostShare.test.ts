import { describe, it, expect } from 'vitest'
import type { Project } from '@shared/types'
import { hostShareOptions } from './relayHostShare'

const proj = (id: string, name: string, extra: Partial<Project> = {}): Project =>
  ({ id, name, nodes: [], ...extra }) as Project

describe('hostShareOptions', () => {
  it('lists open projects with the active one first', () => {
    const opts = hostShareOptions([proj('a', 'A'), proj('b', 'B'), proj('c', 'C')], 'b')
    expect(opts).toEqual([
      { id: 'b', name: 'B' },
      { id: 'a', name: 'A' },
      { id: 'c', name: 'C' }
    ])
  })

  it('excludes closed projects', () => {
    const opts = hostShareOptions(
      [proj('a', 'A'), proj('b', 'B', { closed: true }), proj('c', 'C')],
      'a'
    )
    expect(opts.map((o) => o.id)).toEqual(['a', 'c'])
  })

  it('keeps active first even when it is not the first in the list', () => {
    const opts = hostShareOptions([proj('a', 'A'), proj('b', 'B'), proj('c', 'C')], 'c')
    expect(opts[0]).toEqual({ id: 'c', name: 'C' })
  })

  it('handles an empty project list', () => {
    expect(hostShareOptions([], 'a')).toEqual([])
  })

  it('does not hoist the active project when it is closed (not shareable)', () => {
    const opts = hostShareOptions(
      [proj('a', 'A'), proj('b', 'B', { closed: true })],
      'b'
    )
    expect(opts).toEqual([{ id: 'a', name: 'A' }])
  })
})
