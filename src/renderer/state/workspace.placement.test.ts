import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from './settings'
import { createStickyNode, createTerminalNode } from './workspace'

const GRID = 20

function settings(over: Partial<typeof DEFAULT_SETTINGS>): void {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, ...over } })
}

afterEach(() => settings({}))

describe('new node placement with snap-to-grid', () => {
  // The cursor is the off-grid source: placeAt centres the node on it, so the position is half a
  // width off whatever the pointer happened to hit.
  const cursor = { x: 517, y: 293 }

  it('lands the whole box on the grid, position and size', () => {
    settings({ snapToGrid: true, gridSize: GRID, defaultNodeWidth: 613, defaultNodeHeight: 371 })
    const node = createTerminalNode(0, undefined, cursor)

    expect([node.position.x % GRID, node.position.y % GRID]).toEqual([0, 0])
    expect([(node.width as number) % GRID, (node.height as number) % GRID]).toEqual([0, 0])
  })

  it('keeps style in step with width/height, which is what React Flow paints', () => {
    settings({ snapToGrid: true, gridSize: GRID, defaultNodeWidth: 613, defaultNodeHeight: 371 })
    const node = createTerminalNode(0, undefined, cursor)

    expect(node.style).toEqual({ width: node.width, height: node.height })
  })

  it('snaps a node placed WITHOUT a cursor too (dock, palette, kanban)', () => {
    settings({ snapToGrid: true, gridSize: 16 })
    const node = createStickyNode(3)

    expect([node.position.x % 16, node.position.y % 16]).toEqual([0, 0])
  })

  it('never lands a position on -0, which would ride into project.json', () => {
    settings({ snapToGrid: true, gridSize: GRID })
    const node = createStickyNode(0, { x: 4, y: 4 })

    expect(Object.is(node.position.x, -0)).toBe(false)
    expect(Object.is(node.position.y, -0)).toBe(false)
  })

  it('leaves everything alone with snapping off: the same box as before this existed', () => {
    settings({ snapToGrid: false, gridSize: GRID, defaultNodeWidth: 613, defaultNodeHeight: 371 })
    const node = createTerminalNode(0, undefined, cursor)

    expect(node.position).toEqual({ x: cursor.x - 613 / 2, y: cursor.y - 371 / 2 })
    expect([node.width, node.height]).toEqual([613, 371])
  })

  it('never snaps a node below the minimum its resizer would allow', () => {
    settings({ snapToGrid: true, gridSize: 200 })
    const node = createStickyNode(0, cursor)

    expect(node.width as number).toBeGreaterThanOrEqual(160)
    expect(node.height as number).toBeGreaterThanOrEqual(120)
  })
})
