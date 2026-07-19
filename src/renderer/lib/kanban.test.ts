import { describe, it, expect } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import {
  addColumn, assignNode, assignedTo, defaultKanban, deleteColumn, moveColumn,
  cardMeta, columnForNode, nextColumnColor, pruneAssignments, recolorColumn, renameColumn,
  setCardDue, toggleAssignee, unassigned
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

describe('columnForNode', () => {
  it('resolves the assigned column; undefined for unassigned, dangling, or no board', () => {
    expect(columnForNode(board(), 'n1')).toMatchObject({ id: 'a', title: 'To Do' })
    expect(columnForNode(board(), 'n9')).toBeUndefined()
    const dangling: ProjectKanban = { ...board(), assignments: [{ nodeId: 'n1', columnId: 'gone' }] }
    expect(columnForNode(dangling, 'n1')).toBeUndefined()
    expect(columnForNode(undefined, 'n1')).toBeUndefined()
  })
})

describe('card meta', () => {
  const enes = { name: 'enes', color: '#0a84ff' }
  const mehmet = { name: 'mehmet', color: '#bf5af2' }
  it('cardMeta tolerates absent/malformed meta', () => {
    expect(cardMeta(board(), 'n1')).toBeUndefined()
    const bad = { ...board(), meta: 42 } as unknown as ProjectKanban
    expect(cardMeta(bad, 'n1')).toBeUndefined()
  })
  it('toggleAssignee adds then removes by name; empty meta entries are dropped', () => {
    const k1 = toggleAssignee(board(), 'n1', enes)
    expect(cardMeta(k1, 'n1')?.assignees).toEqual([enes])
    const k2 = toggleAssignee(k1, 'n1', mehmet)
    expect(cardMeta(k2, 'n1')?.assignees).toEqual([enes, mehmet])
    const k3 = toggleAssignee(k2, 'n1', { ...enes, color: '#fff' }) // match by NAME
    expect(cardMeta(k3, 'n1')?.assignees).toEqual([mehmet])
    const k4 = toggleAssignee(toggleAssignee(k3, 'n1', mehmet), 'n1', enes)
    expect(cardMeta(k4, 'n1')?.assignees).toEqual([enes])
    const k5 = toggleAssignee(k4, 'n1', enes)
    expect(cardMeta(k5, 'n1')).toBeUndefined() // nothing left → entry dropped
  })
  it('setCardDue sets and clears; clearing the only field drops the entry', () => {
    const k1 = setCardDue(board(), 'n2', 1784500000000)
    expect(cardMeta(k1, 'n2')?.dueAt).toBe(1784500000000)
    const k2 = setCardDue(k1, 'n2', null)
    expect(cardMeta(k2, 'n2')).toBeUndefined()
  })
  it('pruneAssignments also drops dead nodes\' meta, and stays identity-stable on no-op', () => {
    const k = setCardDue(toggleAssignee(board(), 'n1', enes), 'n9', 5)
    const pruned = pruneAssignments(k, ['n1', 'n2', 'n3'])
    expect(cardMeta(pruned, 'n1')?.assignees).toEqual([enes])
    expect(cardMeta(pruned, 'n9')).toBeUndefined()
    const same = setCardDue(board(), 'n1', 7)
    expect(pruneAssignments(same, ['n1', 'n2', 'n3'])).toBe(same)
  })
})
