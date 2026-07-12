import { describe, it, expect } from 'vitest'
import {
  createAccountLoginNode,
  createAgentNode,
  createChatNode,
  createDinoNode,
  flowToNodeStates,
  groupSelectedNodes,
  nodeStatesToFlow,
  reorderNodeBefore,
  reparentNode,
  resolveNewNodeAccount,
  ungroupNodes
} from './workspace'
import type { CanvasNode } from './workspace'

const term = (id: string, pos: { x: number; y: number }, parentId?: string): CanvasNode =>
  ({
    id,
    type: 'terminal',
    position: pos,
    width: 320,
    height: 240,
    data: { title: id, color: '#888', group: null },
    ...(parentId ? { parentId, extent: 'parent' as const } : {})
  }) as unknown as CanvasNode

const grp = (id: string, pos: { x: number; y: number }): CanvasNode =>
  ({
    id,
    type: 'group',
    position: pos,
    width: 400,
    height: 300,
    data: { title: id, color: '#fff', group: null }
  }) as unknown as CanvasNode

describe('reparentNode', () => {
  it('adds a top-level node to a group with a group-relative position', () => {
    const nodes = [term('t1', { x: 200, y: 150 }), grp('g1', { x: 50, y: 50 })]
    const out = reparentNode(nodes, 't1', 'g1')
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBe('g1')
    expect(t1.extent).toBe('parent')
    expect(t1.position).toEqual({ x: 150, y: 100 })
  })

  it('removes a node from its group, restoring the absolute position', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 }, 'g1')]
    const out = reparentNode(nodes, 't1', null)
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBeUndefined()
    expect(t1.extent).toBeUndefined()
    expect(t1.position).toEqual({ x: 60, y: 60 })
  })

  it('orders group nodes before their children', () => {
    const nodes = [term('t1', { x: 200, y: 150 }), grp('g1', { x: 50, y: 50 })]
    const out = reparentNode(nodes, 't1', 'g1')
    expect(out.findIndex((n) => n.id === 'g1')).toBeLessThan(out.findIndex((n) => n.id === 't1'))
  })

  it('is a no-op when the node is already in the target group', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 }, 'g1')]
    expect(reparentNode(nodes, 't1', 'g1')).toBe(nodes)
  })

  it('is a no-op when the node is missing or the target is not a group', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 })]
    expect(reparentNode(nodes, 'nope', 'g1')).toBe(nodes)
    expect(reparentNode(nodes, 't1', 't1')).toBe(nodes) // target is a terminal, not a group
  })
})

describe('groupSelectedNodes', () => {
  it('wraps the selection in a group frame with group-relative child positions', () => {
    const nodes = [term('t1', { x: 100, y: 100 }), term('t2', { x: 500, y: 300 })]
    const out = groupSelectedNodes(nodes, ['t1', 't2'], 0)
    const group = out[0]
    expect(group.type).toBe('group') // parent placed first (React Flow requirement)
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBe(group.id)
    expect(t1.extent).toBe('parent')
    // absolute position preserved: group position + relative child position
    expect(group.position.x + t1.position.x).toBe(100)
    expect(group.position.y + t1.position.y).toBe(100)
    // frame encloses both members (t2 spans to x=820, y=540)
    expect(group.position.x + (group.width as number)).toBeGreaterThanOrEqual(820)
    expect(group.position.y + (group.height as number)).toBeGreaterThanOrEqual(540)
  })

  it('groups a single node', () => {
    const out = groupSelectedNodes([term('t1', { x: 100, y: 100 })], ['t1'], 0)
    expect(out[0].type).toBe('group')
    expect(out.find((n) => n.id === 't1')!.parentId).toBe(out[0].id)
  })

  it('skips already-grouped children and group frames; all-skipped is a no-op', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('t1', { x: 10, y: 10 }, 'g1')]
    expect(groupSelectedNodes(nodes, ['g1', 't1'], 1)).toBe(nodes)
  })
})

describe('ungroupNodes', () => {
  it('removes the frame and restores children to absolute positions', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 }, 'g1')]
    const out = ungroupNodes(nodes, 'g1')
    expect(out.find((n) => n.id === 'g1')).toBeUndefined()
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBeUndefined()
    expect(t1.extent).toBeUndefined()
    expect(t1.position).toEqual({ x: 60, y: 60 })
  })

  it('round-trips with groupSelectedNodes', () => {
    const nodes = [term('t1', { x: 100, y: 100 }), term('t2', { x: 500, y: 300 })]
    const grouped = groupSelectedNodes(nodes, ['t1', 't2'], 0)
    const out = ungroupNodes(grouped, grouped[0].id)
    expect(out.find((n) => n.id === 't1')!.position).toEqual({ x: 100, y: 100 })
    expect(out.find((n) => n.id === 't2')!.position).toEqual({ x: 500, y: 300 })
  })

  it('is a no-op when the group is missing', () => {
    const nodes = [term('t1', { x: 0, y: 0 })]
    expect(ungroupNodes(nodes, 'nope')).toBe(nodes)
  })
})

describe('reorderNodeBefore', () => {
  const ids = (out: CanvasNode[]): string[] => out.filter((n) => n.type !== 'group').map((n) => n.id)

  it('reorders within the same container (moves dragged before target)', () => {
    const nodes = [term('a', { x: 0, y: 0 }), term('b', { x: 0, y: 0 }), term('c', { x: 0, y: 0 })]
    expect(ids(reorderNodeBefore(nodes, 'c', 'a'))).toEqual(['c', 'a', 'b'])
    expect(ids(reorderNodeBefore(nodes, 'a', 'c'))).toEqual(['b', 'a', 'c'])
  })

  it('keeps position unchanged for a same-container reorder', () => {
    const nodes = [term('a', { x: 5, y: 5 }), term('b', { x: 9, y: 9 })]
    const out = reorderNodeBefore(nodes, 'b', 'a')
    expect(out.find((n) => n.id === 'b')!.position).toEqual({ x: 9, y: 9 })
  })

  it('moves across containers (joins target group) and lands before the target', () => {
    const nodes = [
      grp('g1', { x: 50, y: 50 }),
      term('t1', { x: 10, y: 10 }, 'g1'),
      term('t2', { x: 200, y: 150 }) // ungrouped
    ]
    const out = reorderNodeBefore(nodes, 't2', 't1')
    const t2 = out.find((n) => n.id === 't2')!
    expect(t2.parentId).toBe('g1')
    expect(t2.position).toEqual({ x: 150, y: 100 }) // 200-50, 150-50
    expect(ids(out)).toEqual(['t2', 't1']) // t2 placed before t1
  })

  it('keeps group nodes first and is a no-op for same/ missing / group drags', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('a', { x: 0, y: 0 }), term('b', { x: 0, y: 0 })]
    expect(reorderNodeBefore(nodes, 'a', 'a')).toBe(nodes)
    expect(reorderNodeBefore(nodes, 'nope', 'a')).toBe(nodes)
    expect(reorderNodeBefore(nodes, 'g1', 'a')).toBe(nodes) // can't drag a group row
    const out = reorderNodeBefore(nodes, 'b', 'a')
    expect(out[0].id).toBe('g1')
  })
})

describe('group worktree serialization', () => {
  it('round-trips data.worktree on a group node', () => {
    const group = {
      id: 'group_1',
      type: 'group',
      position: { x: 0, y: 0 },
      width: 400,
      height: 300,
      data: {
        title: 'G',
        color: '#fff',
        group: null,
        worktree: {
          repoPath: '/repo',
          branch: 'feature/x',
          baseRef: 'main',
          path: '/wt/feature-x',
          createdByApp: true
        }
      }
    } as unknown as CanvasNode

    const states = flowToNodeStates([group])
    expect(states[0].worktree).toEqual(group.data.worktree)

    const back = nodeStatesToFlow(states)
    expect(back[0].data.worktree).toEqual(group.data.worktree)
  })

  it('leaves worktree undefined for unbound groups', () => {
    const group = {
      id: 'group_2', type: 'group', position: { x: 0, y: 0 }, width: 1, height: 1,
      data: { title: 'G', color: '#fff', group: null }
    } as unknown as CanvasNode
    expect(flowToNodeStates([group])[0].worktree).toBeUndefined()
  })
})

describe('resolveNewNodeAccount', () => {
  const accounts = [{ id: 'a1', label: 'work', createdAt: 0 }]
  it('prefers the explicit pick', () =>
    expect(resolveNewNodeAccount('a1', { defaultAccountId: 'a2' }, accounts)).toBe('a1'))
  it('falls back to the project default', () =>
    expect(resolveNewNodeAccount(undefined, { defaultAccountId: 'a1' }, accounts)).toBe('a1'))
  it('drops ids that no longer exist', () =>
    expect(resolveNewNodeAccount('gone', { defaultAccountId: 'gone' }, accounts)).toBeUndefined())
  it('undefined when nothing set', () =>
    expect(resolveNewNodeAccount(undefined, {}, accounts)).toBeUndefined())
  it('undefined when the project is undefined', () =>
    expect(resolveNewNodeAccount(undefined, undefined, accounts)).toBeUndefined())
})

describe('accountId on Claude node factories', () => {
  it('stamps accountId onto a Claude agent node', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.accountId).toBe('a1')
  })
  it('does not stamp accountId onto a non-Claude agent node', () => {
    const node = createAgentNode('codex', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.accountId).toBeUndefined()
  })
  it('omits accountId when none is given', () => {
    const node = createAgentNode('claude', 0)
    expect(node.data.accountId).toBeUndefined()
  })
  it('stamps accountId onto a chat node', () => {
    const node = createChatNode(0, undefined, undefined, undefined, 'a1')
    expect(node.data.accountId).toBe('a1')
  })
})

describe('accountId serialization', () => {
  it('round-trips data.accountId on a terminal node', () => {
    const node = {
      id: 'term-1',
      type: 'terminal',
      position: { x: 0, y: 0 },
      width: 600,
      height: 400,
      data: { title: 'T', color: '#888', group: null, agentId: 'claude', accountId: 'a1' }
    } as unknown as CanvasNode
    const states = flowToNodeStates([node])
    expect(states[0].accountId).toBe('a1')
    const back = nodeStatesToFlow(states)
    expect(back[0].data.accountId).toBe('a1')
  })
  it('leaves accountId undefined when unset', () => {
    const node = {
      id: 'term-2', type: 'terminal', position: { x: 0, y: 0 }, width: 1, height: 1,
      data: { title: 'T', color: '#888', group: null }
    } as unknown as CanvasNode
    expect(flowToNodeStates([node])[0].accountId).toBeUndefined()
  })
})

describe('createAccountLoginNode', () => {
  it('produces a terminal node that logs the given account in', () => {
    const node = createAccountLoginNode('acct-1', 0)
    expect(node.type).toBe('terminal')
    expect(node.data.title).toBe('Claude login')
    expect(node.data.accountId).toBe('acct-1')
    expect(node.data.initialCommand).toBe('claude /login')
  })
})

describe('dino node serialization', () => {
  it('round-trips a dino node and its highScore', () => {
    const dino = {
      id: 'dino-1',
      type: 'dino',
      position: { x: 10, y: 20 },
      width: 600,
      height: 200,
      data: { title: 'Dino', color: '#a2a2a2', group: null, highScore: 1337 }
    } as unknown as CanvasNode

    const states = flowToNodeStates([dino])
    expect(states[0].kind).toBe('dino')
    expect(states[0].highScore).toBe(1337)

    const back = nodeStatesToFlow(states)
    expect(back[0].type).toBe('dino')
    expect(back[0].data.highScore).toBe(1337)
  })

  it('createDinoNode produces a dino node with highScore 0', () => {
    const node = createDinoNode(0)
    expect(node.type).toBe('dino')
    expect(node.data.highScore).toBe(0)
    expect(node.width).toBe(600)
  })
})

describe('createAgentNode permission mode', () => {
  it('appends the flag for claude', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, undefined, 'auto')
    expect(node.data.initialCommand).toBe('claude --permission-mode auto')
  })

  it('stays bare in manual mode (legacy parity)', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, undefined, 'manual')
    expect(node.data.initialCommand).toBe('claude')
  })

  it('stays bare when no mode is passed at all (legacy parity)', () => {
    const node = createAgentNode('claude', 0)
    expect(node.data.initialCommand).toBe('claude')
  })

  it('keeps the flag after the initial prompt so the prompt stays claude argv', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, 'fix the bug', undefined, undefined, 'auto')
    expect(node.data.initialCommand).toBe("claude 'fix the bug' --permission-mode auto")
  })

  it('never flags a non-capable agent', () => {
    const node = createAgentNode('codex', 0, undefined, undefined, undefined, undefined, undefined, 'auto')
    expect(node.data.initialCommand).toBe('codex')
  })
})
