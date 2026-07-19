import { describe, expect, it } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import { boardLogEvents } from './boardLogDiff'

const col = (id: string, title: string) => ({ id, title, color: '#111' })
const board = (columns: ProjectKanban['columns'], assignments: ProjectKanban['assignments']): ProjectKanban => ({
  columns,
  assignments
})
// Every real node is relevant by default; a pruned node returns '' (see prune test).
const title = (id: string) => `card-${id}`

describe('boardLogEvents', () => {
  it('assignment added → card-moved from Ungrouped to the new column', () => {
    const cols = [col('c1', 'To Do')]
    const prev = board(cols, [])
    const next = board(cols, [{ nodeId: 'n1', columnId: 'c1' }])
    expect(boardLogEvents(prev, next, title)).toEqual([
      { nodeId: 'n1', event: { type: 'card-moved', from: 'Ungrouped', to: 'To Do' } }
    ])
  })

  it('assignment columnId changed → card-moved from old to new column name', () => {
    const cols = [col('c1', 'To Do'), col('c2', 'Done')]
    const prev = board(cols, [{ nodeId: 'n1', columnId: 'c1' }])
    const next = board(cols, [{ nodeId: 'n1', columnId: 'c2' }])
    expect(boardLogEvents(prev, next, title)).toEqual([
      { nodeId: 'n1', event: { type: 'card-moved', from: 'To Do', to: 'Done' } }
    ])
  })

  it('assignment removed while node still relevant → card-moved to Ungrouped', () => {
    const cols = [col('c1', 'To Do')]
    const prev = board(cols, [{ nodeId: 'n1', columnId: 'c1' }])
    const next = board(cols, [])
    expect(boardLogEvents(prev, next, title)).toEqual([
      { nodeId: 'n1', event: { type: 'card-moved', from: 'To Do', to: 'Ungrouped' } }
    ])
  })

  it('assignment removed by prune (node gone) → no move', () => {
    const cols = [col('c1', 'To Do')]
    const prev = board(cols, [{ nodeId: 'gone', columnId: 'c1' }])
    const next = board(cols, [])
    // cardTitle('gone') === '' → the node no longer exists (pruneAssignments), so no move noise.
    expect(boardLogEvents(prev, next, (id) => (id === 'gone' ? '' : `card-${id}`))).toEqual([])
  })

  it('column added → column-added {title}', () => {
    const prev = board([col('c1', 'To Do')], [])
    const next = board([col('c1', 'To Do'), col('c2', 'Done')], [])
    expect(boardLogEvents(prev, next, title)).toEqual([{ event: { type: 'column-added', title: 'Done' } }])
  })

  it('column title changed → column-renamed {from,to}', () => {
    const prev = board([col('c1', 'To Do')], [])
    const next = board([col('c1', 'Doing')], [])
    expect(boardLogEvents(prev, next, title)).toEqual([{ event: { type: 'column-renamed', from: 'To Do', to: 'Doing' } }])
  })

  it('column deleted → only column-deleted {title}; per-card moves to Ungrouped are suppressed', () => {
    const prev = board([col('c1', 'To Do'), col('c2', 'Done')], [
      { nodeId: 'n1', columnId: 'c2' },
      { nodeId: 'n2', columnId: 'c2' }
    ])
    // deleteColumn('c2') removes the column AND both assignments.
    const next = board([col('c1', 'To Do')], [])
    expect(boardLogEvents(prev, next, title)).toEqual([{ event: { type: 'column-deleted', title: 'Done' } }])
  })

  it('pure column reorder → []', () => {
    const prev = board([col('c1', 'To Do'), col('c2', 'Done')], [])
    const next = board([col('c2', 'Done'), col('c1', 'To Do')], [])
    expect(boardLogEvents(prev, next, title)).toEqual([])
  })

  it('intra-column card order change → []', () => {
    const cols = [col('c1', 'To Do')]
    const prev = board(cols, [
      { nodeId: 'a', columnId: 'c1' },
      { nodeId: 'b', columnId: 'c1' }
    ])
    const next = board(cols, [
      { nodeId: 'b', columnId: 'c1' },
      { nodeId: 'a', columnId: 'c1' }
    ])
    expect(boardLogEvents(prev, next, title)).toEqual([])
  })

  it('no change at all → []', () => {
    const cols = [col('c1', 'To Do')]
    const b = board(cols, [{ nodeId: 'a', columnId: 'c1' }])
    expect(boardLogEvents(b, b, title)).toEqual([])
  })

  it('dangling prev assignment (column already missing) resolves from-name to Ungrouped', () => {
    // Assignment points at a column that exists in neither board (a leftover from elsewhere);
    // moving it into a real column reads as coming from Ungrouped.
    const prev = board([col('c1', 'To Do')], [{ nodeId: 'n1', columnId: 'dead' }])
    const next = board([col('c1', 'To Do')], [{ nodeId: 'n1', columnId: 'c1' }])
    expect(boardLogEvents(prev, next, title)).toEqual([
      { nodeId: 'n1', event: { type: 'card-moved', from: 'Ungrouped', to: 'To Do' } }
    ])
  })
})
