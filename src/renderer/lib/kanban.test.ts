import { describe, it, expect } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import {
  addColumn, assignNode, assignedTo, defaultKanban, deleteColumn, moveColumn,
  nextColumnColor, pruneAssignments, recolorColumn, renameColumn, unassigned
} from './kanban'

const board = (): ProjectKanban => ({
  columns: [
    { id: 'a', title: 'To Do', color: '#0a84ff' },
    { id: 'b', title: 'Doing', color: '#ffd60a' }
  ],
  assignments: [
    { nodeId: 'n1', columnId: 'a' },
    { nodeId: 'n2', columnId: 'b' },
    { nodeId: 'n3', columnId: 'a' }
  ]
})

describe('defaultKanban', () => {
  it('makes To Do / In Progress / Done with unique ids and no assignments', () => {
    const k = defaultKanban()
    expect(k.columns.map((c) => c.title)).toEqual(['To Do', 'In Progress', 'Done'])
    expect(new Set(k.columns.map((c) => c.id)).size).toBe(3)
    expect(k.assignments).toEqual([])
  })
})

describe('columns', () => {
  it('addColumn appends; nextColumnColor cycles the palette', () => {
    const k = addColumn(board(), 'Review', nextColumnColor(board()))
    expect(k.columns).toHaveLength(3)
    expect(k.columns[2].title).toBe('Review')
  })
  it('renameColumn / recolorColumn touch only the target', () => {
    const k = recolorColumn(renameColumn(board(), 'b', 'WIP'), 'b', '#fff')
    expect(k.columns[1]).toMatchObject({ id: 'b', title: 'WIP', color: '#fff' })
    expect(k.columns[0]).toEqual(board().columns[0])
  })
  it('moveColumn before a target and to the end (null)', () => {
    expect(moveColumn(board(), 'b', 'a').columns.map((c) => c.id)).toEqual(['b', 'a'])
    expect(moveColumn(board(), 'a', null).columns.map((c) => c.id)).toEqual(['b', 'a'])
  })
  it('deleteColumn drops the column AND its assignments (cards return to Ungrouped); unknown id no-op', () => {
    const k = deleteColumn(board(), 'a')
    expect(k.columns.map((c) => c.id)).toEqual(['b'])
    expect(k.assignments).toEqual([{ nodeId: 'n2', columnId: 'b' }])
    expect(deleteColumn(board(), 'nope')).toEqual(board())
  })
  it('deleting every user column is allowed (Ungrouped always remains)', () => {
    const k = deleteColumn(deleteColumn(board(), 'a'), 'b')
    expect(k.columns).toEqual([])
    expect(k.assignments).toEqual([])
  })
})

describe('assignments', () => {
  it('assignedTo returns a column in array order; unassigned follows sessionIds order', () => {
    expect(assignedTo(board(), 'a')).toEqual(['n1', 'n3'])
    expect(unassigned(board(), ['n4', 'n1', 'n5'])).toEqual(['n4', 'n5'])
  })
  it('a dangling assignment (missing column) counts as unassigned', () => {
    const k: ProjectKanban = { ...board(), assignments: [{ nodeId: 'n1', columnId: 'gone' }] }
    expect(unassigned(k, ['n1', 'n2'])).toEqual(['n1', 'n2'])
    expect(assignedTo(k, 'a')).toEqual([])
  })
  it('assignNode into a column at the end (null) and before a target', () => {
    const atEnd = assignNode(board(), 'n9', 'b', null)
    expect(assignedTo(atEnd, 'b')).toEqual(['n2', 'n9'])
    const before = assignNode(board(), 'n2', 'a', 'n3')
    expect(assignedTo(before, 'a')).toEqual(['n1', 'n2', 'n3'])
    expect(assignedTo(before, 'b')).toEqual([])
  })
  it('assignNode with columnId null removes the assignment (back to Ungrouped)', () => {
    const k = assignNode(board(), 'n1', null, null)
    expect(k.assignments.map((a) => a.nodeId)).toEqual(['n2', 'n3'])
  })
  it('assignNode: beforeNode in a different column ⇒ end; unknown column ⇒ no-op; self-before ⇒ no-op', () => {
    const k = assignNode(board(), 'n1', 'b', 'n3')
    expect(assignedTo(k, 'b')).toEqual(['n2', 'n1'])
    expect(assignNode(board(), 'n1', 'nope', null)).toEqual(board())
    expect(assignNode(board(), 'n1', 'a', 'n1')).toEqual(board())
  })
  it('pruneAssignments drops dead nodes, returns the same object when nothing changes', () => {
    const k = pruneAssignments(board(), ['n1', 'n3'])
    expect(k.assignments.map((a) => a.nodeId)).toEqual(['n1', 'n3'])
    const same = board()
    expect(pruneAssignments(same, ['n1', 'n2', 'n3'])).toBe(same)
  })
})
