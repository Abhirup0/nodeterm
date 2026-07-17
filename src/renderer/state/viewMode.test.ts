import { describe, it, expect } from 'vitest'
import { parseViewMap, useViewMode } from './viewMode'

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
