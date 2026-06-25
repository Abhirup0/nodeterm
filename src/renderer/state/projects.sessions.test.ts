import { describe, it, expect, beforeEach } from 'vitest'
import { useProjects } from './projects'
import type { CanvasNodeState } from '@shared/types'

const mkNode = (id: string): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 320, height: 240 },
  title: id,
  color: '#888',
  group: null
})

beforeEach(() => {
  useProjects.setState({
    projects: [
      { id: 'p1', name: 'P1', color: '#111', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [mkNode('n1')] }
    ],
    activeProjectId: 'p1'
  })
})

describe('projects store node mutations', () => {
  it('renames a node in a project', () => {
    useProjects.getState().renameNode('p1', 'n1', 'hello')
    expect(useProjects.getState().getProject('p1')!.nodes[0].title).toBe('hello')
  })

  it('recolors a node', () => {
    useProjects.getState().recolorNode('p1', 'n1', '#abc')
    expect(useProjects.getState().getProject('p1')!.nodes[0].color).toBe('#abc')
  })

  it('removes a node', () => {
    useProjects.getState().removeNode('p1', 'n1')
    expect(useProjects.getState().getProject('p1')!.nodes).toHaveLength(0)
  })

  it('duplicates a node with a new id and offset position', () => {
    useProjects.getState().duplicateNode('p1', 'n1')
    const nodes = useProjects.getState().getProject('p1')!.nodes
    expect(nodes).toHaveLength(2)
    expect(nodes[1].id).not.toBe('n1')
    expect(nodes[1].position).not.toEqual(nodes[0].position)
  })
})

describe('moveNodeToGroup', () => {
  const group = (id: string, x: number, y: number): CanvasNodeState => ({
    id,
    kind: 'group',
    position: { x, y },
    size: { width: 400, height: 300 },
    title: id,
    color: '#fff',
    group: null
  })
  const at = (id: string, x: number, y: number, parentId?: string): CanvasNodeState => ({
    ...mkNode(id),
    position: { x, y },
    ...(parentId ? { parentId } : {})
  })

  beforeEach(() => {
    useProjects.setState({
      projects: [
        {
          id: 'p1',
          name: 'P1',
          color: '#111',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [group('g1', 50, 50), at('n1', 200, 150)]
        }
      ],
      activeProjectId: 'p1'
    })
  })

  it('adds a node to a group with a group-relative position', () => {
    useProjects.getState().moveNodeToGroup('p1', 'n1', 'g1')
    const n1 = useProjects.getState().getProject('p1')!.nodes.find((n) => n.id === 'n1')!
    expect(n1.parentId).toBe('g1')
    expect(n1.position).toEqual({ x: 150, y: 100 })
  })

  it('removes a node from its group, restoring the absolute position', () => {
    useProjects.setState({
      projects: [
        {
          id: 'p1',
          name: 'P1',
          color: '#111',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [group('g1', 50, 50), at('n1', 10, 10, 'g1')]
        }
      ],
      activeProjectId: 'p1'
    })
    useProjects.getState().moveNodeToGroup('p1', 'n1', null)
    const n1 = useProjects.getState().getProject('p1')!.nodes.find((n) => n.id === 'n1')!
    expect(n1.parentId).toBeUndefined()
    expect(n1.position).toEqual({ x: 60, y: 60 })
  })

  it('is a no-op when the node is missing', () => {
    const before = useProjects.getState().getProject('p1')!.nodes
    useProjects.getState().moveNodeToGroup('p1', 'nope', 'g1')
    expect(useProjects.getState().getProject('p1')!.nodes).toBe(before)
  })
})
