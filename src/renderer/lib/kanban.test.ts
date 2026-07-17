import { describe, it, expect } from 'vitest'
import type { ProjectKanban } from '@shared/types'
import {
  addCard, addColumn, cardsInColumn, defaultKanban, deleteCard, deleteColumn,
  moveCard, moveColumn, nextColumnColor, recolorColumn, renameColumn, updateCard
} from './kanban'

const board = (): ProjectKanban => ({
  columns: [
    { id: 'a', title: 'To Do', color: '#0a84ff' },
    { id: 'b', title: 'Doing', color: '#ffd60a' },
    { id: 'c', title: 'Done', color: '#32d74b' }
  ],
  cards: [
    { id: 'c1', columnId: 'a', title: 'one', createdAt: 1 },
    { id: 'c2', columnId: 'b', title: 'two', createdAt: 2 },
    { id: 'c3', columnId: 'a', title: 'three', createdAt: 3 }
  ]
})

describe('defaultKanban', () => {
  it('makes To Do / In Progress / Done with unique ids and no cards', () => {
    const k = defaultKanban()
    expect(k.columns.map((c) => c.title)).toEqual(['To Do', 'In Progress', 'Done'])
    expect(new Set(k.columns.map((c) => c.id)).size).toBe(3)
    expect(k.cards).toEqual([])
  })
})

describe('columns', () => {
  it('addColumn appends with the given title/color; nextColumnColor cycles the palette', () => {
    const k = addColumn(board(), 'Review', nextColumnColor(board()))
    expect(k.columns).toHaveLength(4)
    expect(k.columns[3].title).toBe('Review')
    expect(k.columns[3].color).toBe(nextColumnColor(board()))
  })
  it('renameColumn / recolorColumn touch only the target', () => {
    const k = recolorColumn(renameColumn(board(), 'b', 'WIP'), 'b', '#fff')
    expect(k.columns[1]).toMatchObject({ id: 'b', title: 'WIP', color: '#fff' })
    expect(k.columns[0]).toEqual(board().columns[0])
  })
  it('moveColumn before a target and to the end (null)', () => {
    expect(moveColumn(board(), 'c', 'a').columns.map((c) => c.id)).toEqual(['c', 'a', 'b'])
    expect(moveColumn(board(), 'a', null).columns.map((c) => c.id)).toEqual(['b', 'c', 'a'])
    expect(moveColumn(board(), 'a', 'a')).toEqual(board())
  })
  it('deleteColumn migrates cards to the first remaining column, keeps array order', () => {
    const k = deleteColumn(board(), 'a')!
    expect(k.columns.map((c) => c.id)).toEqual(['b', 'c'])
    expect(k.cards.map((c) => [c.id, c.columnId])).toEqual([['c1', 'b'], ['c2', 'b'], ['c3', 'b']])
  })
  it('deleteColumn refuses the last column (null); unknown id is a no-op', () => {
    const one: ProjectKanban = { columns: [{ id: 'x', title: 't', color: '#fff' }], cards: [] }
    expect(deleteColumn(one, 'x')).toBeNull()
    expect(deleteColumn(board(), 'nope')).toEqual(board())
  })
})

describe('cards', () => {
  it('cardsInColumn returns that column in array order', () => {
    expect(cardsInColumn(board(), 'a').map((c) => c.id)).toEqual(['c1', 'c3'])
  })
  it('addCard appends to the end of the column; unknown column is a no-op', () => {
    const k = addCard(board(), 'a', 'four', 4)
    expect(cardsInColumn(k, 'a').map((c) => c.title)).toEqual(['one', 'three', 'four'])
    expect(k.cards[3].createdAt).toBe(4)
    expect(addCard(board(), 'nope', 'x', 1)).toEqual(board())
  })
  it('updateCard patches title/description and drops an emptied description', () => {
    const k = updateCard(board(), 'c1', { title: 'ONE', description: 'body' })
    expect(k.cards[0]).toMatchObject({ title: 'ONE', description: 'body' })
    const k2 = updateCard(k, 'c1', { description: undefined })
    expect('description' in k2.cards[0]).toBe(false)
  })
  it('deleteCard removes it', () => {
    expect(deleteCard(board(), 'c2').cards.map((c) => c.id)).toEqual(['c1', 'c3'])
  })
  it('moveCard across columns to the end (null) and before a target card', () => {
    const toEnd = moveCard(board(), 'c1', 'b', null)
    expect(cardsInColumn(toEnd, 'b').map((c) => c.id)).toEqual(['c2', 'c1'])
    const before = moveCard(board(), 'c2', 'a', 'c3')
    expect(cardsInColumn(before, 'a').map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
    expect(cardsInColumn(before, 'b')).toEqual([])
  })
  it('moveCard reorders within a column', () => {
    const k = moveCard(board(), 'c3', 'a', 'c1')
    expect(cardsInColumn(k, 'a').map((c) => c.id)).toEqual(['c3', 'c1'])
  })
  it('moveCard: beforeCard in a DIFFERENT column ⇒ lands at the end; unknown ids are no-ops', () => {
    const k = moveCard(board(), 'c1', 'b', 'c3') // c3 is in column a, target is b
    expect(cardsInColumn(k, 'b').map((c) => c.id)).toEqual(['c2', 'c1'])
    expect(moveCard(board(), 'nope', 'a', null)).toEqual(board())
    expect(moveCard(board(), 'c1', 'nope', null)).toEqual(board())
  })
})
