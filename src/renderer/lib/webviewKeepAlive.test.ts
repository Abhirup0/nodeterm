import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../state/workspace'
import {
  activateInPool,
  BACKGROUND_WEBVIEW_MAX,
  backgroundNodeIds,
  evictOverCap,
  ghostFlowNode,
  hasKeepAliveContent,
  isKeepAliveKind,
  mergeWithKeepAlive,
  overlayKeepAliveData,
  retireIntoPool,
  type KeepAliveEntry
} from './webviewKeepAlive'

const node = (id: string, type: string, data: Record<string, unknown> = {}): CanvasNode =>
  ({
    id,
    type,
    position: { x: 10, y: 10 },
    width: 400,
    height: 300,
    data: { title: id, color: '#0a84ff', group: null, ...data }
  }) as unknown as CanvasNode

const browser = (id: string, url = 'https://x.test/'): CanvasNode => node(id, 'browser', { url })

describe('mergeWithKeepAlive', () => {
  it('returns the live array itself when no webview node exists anywhere', () => {
    const live = [node('t1', 'terminal'), node('s1', 'sticky')]
    expect(mergeWithKeepAlive(live, [], [], 'p1')).toBe(live)
  })

  it('appends ephemerals when no webview node exists', () => {
    const live = [node('t1', 'terminal')]
    const eph = [node('sub1', 'subagent')]
    expect(mergeWithKeepAlive(live, eph, [], 'p1').map((n) => n.id)).toEqual(['t1', 'sub1'])
  })

  it('hoists active webview nodes to the tail region, after ephemerals', () => {
    const live = [browser('b1'), node('t1', 'terminal'), node('w1', 'web'), node('t2', 'terminal')]
    const eph = [node('sub1', 'subagent')]
    const merged = mergeWithKeepAlive(live, eph, [], 'p1')
    expect(merged.map((n) => n.id)).toEqual(['t1', 't2', 'sub1', 'b1', 'w1'])
    // Live objects, not copies — position/selection/data must flow through untouched.
    expect(merged[3]).toBe(live[0])
  })

  it('renders pool entries in pool order: live for the active project, ghost otherwise', () => {
    const live = [node('t1', 'terminal'), browser('b1')]
    const entries: KeepAliveEntry[] = [
      { nodeId: 'bg1', projectId: 'p2', node: { type: 'browser', data: { url: 'https://a/' } as never }, retiredAt: 5 },
      { nodeId: 'b1', projectId: 'p1', node: { type: 'browser', data: {} as never }, retiredAt: 0 }
    ]
    const merged = mergeWithKeepAlive(live, [], entries, 'p1')
    expect(merged.map((n) => n.id)).toEqual(['t1', 'bg1', 'b1'])
    expect(merged[1].data.ghost).toBe(true)
    expect(merged[2]).toBe(live[1])
  })

  it('keeps a returning entry as a GHOST through the switch window (nodes not yet swapped)', () => {
    // The regression the real app exposed: after the tab click, one commit renders with the new
    // ACTIVE id while the node array is still the outgoing project's. The merge is keyed on the
    // MOUNTED project for exactly this reason — the returning entry must stay in the output (as
    // its ghost), not take the live branch, miss its node, and unmount for a commit.
    const entries = retireIntoPool([], 'p1', [browser('b1')], 1000)
    const outgoingNodes = [browser('c1')] // p2's canvas, still mounted
    const merged = mergeWithKeepAlive(outgoingNodes, [], entries, 'p2')
    expect(merged.map((n) => n.id)).toEqual(['b1', 'c1'])
    expect(merged[0].data.ghost).toBe(true)
  })

  it("falls back to the GHOST for a mounted entry whose node is missing, and appends actives the pool doesn't know", () => {
    // The miss is USUALLY a cross-store commit interleaving mid-switch (see the merge's doc) — an
    // id absent from one commit is an unmount and a dead guest, so the entry must keep rendering.
    // A genuinely deleted node's entry is dropped by the deletion funnels, not by this merge.
    const live = [browser('new1')]
    const entries: KeepAliveEntry[] = [
      { nodeId: 'gone', projectId: 'p1', node: { type: 'browser', data: {} as never }, retiredAt: 0 }
    ]
    const merged = mergeWithKeepAlive(live, [], entries, 'p1')
    expect(merged.map((n) => n.id)).toEqual(['gone', 'new1'])
    expect(merged[0].data.ghost).toBe(true)
  })
})

describe('ghostFlowNode', () => {
  const entry: KeepAliveEntry = {
    nodeId: 'b1',
    projectId: 'p2',
    node: { type: 'browser', width: 560, height: 400, data: { url: 'https://x/', partition: 'persist:x' } as never },
    retiredAt: 1
  }

  it('is hidden, inert, parked at the origin, and flagged for the surfaces', () => {
    const g = ghostFlowNode(entry)
    expect(g.id).toBe('b1')
    expect(g.type).toBe('browser')
    expect(g.style).toEqual({ display: 'none' })
    expect(g.position).toEqual({ x: 0, y: 0 })
    expect(g.selectable).toBe(false)
    expect(g.draggable).toBe(false)
    expect(g.deletable).toBe(false)
    expect(g.data.ghost).toBe(true)
    expect(g.data.url).toBe('https://x/')
    expect(g.data.partition).toBe('persist:x')
  })

  it('caches by entry identity so a drag-frame merge re-emits the same object', () => {
    expect(ghostFlowNode(entry)).toBe(ghostFlowNode(entry))
    expect(ghostFlowNode({ ...entry })).not.toBe(ghostFlowNode(entry))
  })
})

describe('retireIntoPool', () => {
  it('snapshots content-bearing webview nodes, in array order, and skips the rest', () => {
    const out = retireIntoPool(
      [],
      'p1',
      [node('t1', 'terminal'), browser('b1'), node('w1', 'web', { filePath: '/x.html' }), browser('empty', '')],
      1000
    )
    expect(out.map((e) => e.nodeId)).toEqual(['b1', 'w1'])
    expect(out[0]).toMatchObject({ projectId: 'p1', retiredAt: 1000 })
    expect(out[0].node.data.url).toBe('https://x.test/')
  })

  it('keeps an existing entry ORDER SLOT on re-retire and prunes deleted nodes', () => {
    const first = retireIntoPool([], 'p1', [browser('b1'), browser('b2')], 1000)
    const other = retireIntoPool(first, 'p2', [browser('c1')], 2000)
    // p1 comes back with b2 deleted and b3 created; b1 must keep its slot before c1.
    const again = retireIntoPool(other, 'p1', [browser('b3'), browser('b1')], 3000)
    expect(again.map((e) => e.nodeId)).toEqual(['b1', 'c1', 'b3'])
  })

  it('evicts the longest-retired background entries beyond the cap', () => {
    let entries: KeepAliveEntry[] = []
    for (let i = 0; i < BACKGROUND_WEBVIEW_MAX + 3; i++) {
      entries = retireIntoPool(entries, `p${i}`, [browser(`b${i}`)], 1000 + i)
    }
    expect(entries).toHaveLength(BACKGROUND_WEBVIEW_MAX)
    // Oldest three retire clocks are gone.
    expect(entries.map((e) => e.nodeId)).toEqual(
      Array.from({ length: BACKGROUND_WEBVIEW_MAX }, (_, i) => `b${i + 3}`)
    )
  })

  it('activateInPool sheds the background clock BEFORE the next retire can evict it', () => {
    const first = retireIntoPool([], 'p1', [browser('b1')], 1000)
    // Cap 1: without activation, switching p2→p1 would evict b1 at the very switch revealing it.
    const activated = activateInPool(first, 'p1')
    const afterRetire = retireIntoPool(activated, 'p2', [browser('c1')], 2000, 1)
    expect(afterRetire.map((e) => e.nodeId)).toEqual(['b1', 'c1'])
    expect(afterRetire[0].retiredAt).toBe(0)
  })

  it('never counts ACTIVE entries against the cap, and never evicts them', () => {
    const active: KeepAliveEntry[] = Array.from({ length: 5 }, (_, i) => ({
      nodeId: `a${i}`,
      projectId: 'pX',
      node: { type: 'browser', data: {} as never },
      retiredAt: 0
    }))
    const out = evictOverCap([...active], 2)
    expect(out).toHaveLength(5)
  })
})

describe('overlayKeepAliveData', () => {
  it('applies the pool url/title of the returning project and leaves equal nodes untouched', () => {
    const flow = [browser('b1', 'https://old/'), browser('b2', 'https://same/')]
    const entries: KeepAliveEntry[] = [
      { nodeId: 'b1', projectId: 'p1', node: { type: 'browser', data: { url: 'https://new/', title: 'T' } as never }, retiredAt: 1 },
      { nodeId: 'b2', projectId: 'p1', node: { type: 'browser', data: { url: 'https://same/', title: 'b2' } as never }, retiredAt: 1 },
      { nodeId: 'zz', projectId: 'p9', node: { type: 'browser', data: { url: 'https://other/' } as never }, retiredAt: 1 }
    ]
    const out = overlayKeepAliveData(flow, entries, 'p1')
    expect(out[0].data.url).toBe('https://new/')
    expect(out[0].data.title).toBe('T')
    expect(out[1]).toBe(flow[1])
  })
})

describe('backgroundNodeIds', () => {
  it('names only the entries of OTHER projects', () => {
    const entries: KeepAliveEntry[] = [
      { nodeId: 'a', projectId: 'p1', node: { type: 'browser', data: {} as never }, retiredAt: 0 },
      { nodeId: 'b', projectId: 'p2', node: { type: 'browser', data: {} as never }, retiredAt: 1 }
    ]
    expect([...backgroundNodeIds(entries, 'p1')]).toEqual(['b'])
  })
})

describe('helpers', () => {
  it('classify kinds and content', () => {
    expect(isKeepAliveKind(node('x', 'browser'))).toBe(true)
    expect(isKeepAliveKind(node('x', 'web'))).toBe(true)
    expect(isKeepAliveKind(node('x', 'terminal'))).toBe(false)
    expect(hasKeepAliveContent(browser('x'))).toBe(true)
    expect(hasKeepAliveContent(node('x', 'web', { filePath: '/f.html' }))).toBe(true)
    expect(hasKeepAliveContent(browser('x', ''))).toBe(false)
  })
})

/**
 * THE invariant the whole feature rests on (see the lib header): between any two consecutive merge
 * outputs, the ids present in BOTH must appear in the same relative order — React only touches a
 * kept element's DOM (killing a webview guest) when its relative order among kept children changes.
 */
describe('order stability across a switch script', () => {
  const relativeOrderStable = (prev: string[], next: string[]): boolean => {
    const nextIndex = new Map(next.map((id, i) => [id, i]))
    const shared = prev.filter((id) => nextIndex.has(id))
    for (let i = 1; i < shared.length; i++) {
      if ((nextIndex.get(shared[i - 1]) ?? 0) > (nextIndex.get(shared[i]) ?? 0)) return false
    }
    return true
  }

  it('holds across switches, creates, deletes, evictions and prunes', () => {
    // Three projects with webview nodes, plus churn.
    const projects: Record<string, CanvasNode[]> = {
      p1: [node('t1', 'terminal'), browser('b1'), browser('b2')],
      p2: [browser('c1'), node('t2', 'terminal'), node('w2', 'web', { filePath: '/w.html' })],
      p3: [node('t3', 'terminal')]
    }
    let entries: KeepAliveEntry[] = []
    let activePid = 'p1'
    let prevMergedIds: string[] | null = null
    let clock = 1000

    const switchTo = (pid: string): void => {
      // Same order as Canvas's load effect: activate the incoming project, then retire the
      // outgoing one (see activateInPool's doc for why this order is load-bearing).
      entries = activateInPool(entries, pid)
      entries = retireIntoPool(entries, activePid, projects[activePid], ++clock)
      activePid = pid
    }
    const checkMerge = (): void => {
      const merged = mergeWithKeepAlive(projects[activePid], [], entries, activePid).map((n) => n.id)
      // No duplicate ids, ever — one id rendering twice is two elements fighting for one key.
      expect(new Set(merged).size).toBe(merged.length)
      if (prevMergedIds) expect(relativeOrderStable(prevMergedIds, merged)).toBe(true)
      prevMergedIds = merged
    }

    checkMerge()
    switchTo('p2')
    checkMerge()
    // p1's pages navigate in the background; p2 creates a browser node.
    projects.p2.push(browser('c2'))
    checkMerge()
    switchTo('p3')
    checkMerge()
    switchTo('p1')
    checkMerge()
    // Delete b1 while active, then leave.
    projects.p1 = projects.p1.filter((n) => n.id !== 'b1')
    checkMerge()
    switchTo('p2')
    checkMerge()
    switchTo('p3')
    checkMerge()
    // Back to p1: b2 must have kept its slot through everything.
    switchTo('p1')
    checkMerge()
  })
})
