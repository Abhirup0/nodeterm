import { describe, it, expect } from 'vitest'
import { parseViewMap, useViewMode, isKanbanOpen } from './viewMode'

describe('parseViewMap', () => {
  it('keeps only kanban entries, tolerates garbage', () => {
    expect(parseViewMap(null)).toEqual({})
    expect(parseViewMap('not json')).toEqual({})
    expect(parseViewMap('[1,2]')).toEqual({})
    expect(parseViewMap(JSON.stringify({ p1: 'kanban', p2: 'canvas', p3: 42 }))).toEqual({ p1: 'kanban' })
  })
})

describe('toggle', () => {
  it('flips a project in and out of kanban', () => {
    useViewMode.getState().toggle('p1')
    expect(useViewMode.getState().viewByProject.p1).toBe('kanban')
    useViewMode.getState().toggle('p1')
    expect(useViewMode.getState().viewByProject.p1).toBeUndefined()
  })
})

describe('card requests (board-aware "go to node")', () => {
  it('carries a one-shot request the board consumes', () => {
    useViewMode.setState({ requestedCardNodeId: null })
    useViewMode.getState().requestCard('term-1')
    expect(useViewMode.getState().requestedCardNodeId).toBe('term-1')
    useViewMode.getState().clearCardRequest()
    expect(useViewMode.getState().requestedCardNodeId).toBeNull()
    // Re-requesting the SAME node must work — it is a fresh "go to", not a state to dedupe.
    useViewMode.getState().requestCard('term-1')
    expect(useViewMode.getState().requestedCardNodeId).toBe('term-1')
  })

  it('a view toggle drops an unconsumed request', () => {
    useViewMode.setState({ viewByProject: {}, requestedCardNodeId: null })
    useViewMode.getState().toggle('p9')
    expect(isKanbanOpen('p9')).toBe(true)
    useViewMode.getState().requestCard('term-2')
    // Leaving the board: the request belonged to the view we just left; firing it later would
    // pop a card open out of nowhere.
    useViewMode.getState().toggle('p9')
    expect(isKanbanOpen('p9')).toBe(false)
    expect(useViewMode.getState().requestedCardNodeId).toBeNull()
  })
})
