import { describe, it, expect } from 'vitest'
import {
  ROPE_NEUTRAL,
  dropAfterDep,
  edgeHidden,
  hiddenEdgeNodeIds,
  ropeVisual,
  type RopeNodeInfo
} from './edgeModel'

const infoOf =
  (m: Record<string, RopeNodeInfo>) =>
  (id: string): RopeNodeInfo | undefined =>
    m[id]

describe('ropeVisual — one rope, its look derived from the target\'s pendingLaunch', () => {
  it('a rope whose target is still waiting on its source is WAITING', () => {
    const v = ropeVisual({ source: 'y', target: 'n' }, infoOf({ y: { agentColor: '#d97757' }, n: { pendingAfter: ['y'] } }))
    expect(v).toEqual({ waiting: true, color: '#d97757' })
  })

  it('the same rope is solid once the target no longer lists the source (launched, or disarmed)', () => {
    expect(ropeVisual({ source: 'y', target: 'n' }, infoOf({ y: { agentColor: '#d97757' }, n: { pendingAfter: [] } })).waiting).toBe(false)
    expect(ropeVisual({ source: 'y', target: 'n' }, infoOf({ y: { agentColor: '#d97757' }, n: {} })).waiting).toBe(false)
  })

  it('an opener rope is never "waiting" just because the target waits on SOMEONE ELSE', () => {
    expect(ropeVisual({ source: 'x', target: 'n' }, infoOf({ x: { agentColor: '#10a37f' }, n: { pendingAfter: ['y'] } })).waiting).toBe(false)
  })

  it('takes the SOURCE\'s agent colour; a source with no agent (browser popup) is neutral grey', () => {
    expect(ropeVisual({ source: 'x', target: 'n' }, infoOf({ x: { agentColor: '#10a37f' }, n: {} })).color).toBe('#10a37f')
    expect(ropeVisual({ source: 'b', target: 'n' }, infoOf({ b: {}, n: {} })).color).toBe(ROPE_NEUTRAL)
    expect(ropeVisual({ source: 'gone', target: 'n' }, infoOf({ n: {} })).color).toBe(ROPE_NEUTRAL)
  })
})

describe('dropAfterDep — deleting a waiting rope means "stop waiting on that one"', () => {
  it('removes exactly that dep and keeps the command', () => {
    const p = { after: ['a', 'b'], command: 'claude "x"' }
    expect(dropAfterDep(p, 'a')).toEqual({ after: ['b'], command: 'claude "x"' })
  })

  it('returns the SAME object when the dep is not listed (no spurious re-render)', () => {
    const p = { after: ['a'], command: 'c' }
    expect(dropAfterDep(p, 'zzz')).toBe(p)
  })

  it('leaves an empty list rather than disarming — launchesToFire fires a vacuous wait', () => {
    expect(dropAfterDep({ after: ['a'], command: 'c' }, 'a')).toEqual({ after: [], command: 'c' })
  })

  it('keeps awaitSetupGroup', () => {
    expect(dropAfterDep({ after: ['a'], command: 'c', awaitSetupGroup: 'g1' }, 'a')).toEqual({ after: [], command: 'c', awaitSetupGroup: 'g1' })
  })
})

describe('hiddenEdgeNodeIds / edgeHidden — the eye hides every edge touching the node', () => {
  const nodes = [
    { id: 'a', data: { hideFanout: true } },
    { id: 'b', data: {} },
    { id: 'c', data: { hideFanout: false } }
  ]
  it('collects only nodes whose eye is closed', () => {
    expect([...hiddenEdgeNodeIds(nodes)]).toEqual(['a'])
  })
  it('hides an edge on EITHER end, in either direction', () => {
    const hidden = hiddenEdgeNodeIds(nodes)
    expect(edgeHidden({ source: 'a', target: 'b' }, hidden)).toBe(true)
    expect(edgeHidden({ source: 'b', target: 'a' }, hidden)).toBe(true)
    expect(edgeHidden({ source: 'b', target: 'c' }, hidden)).toBe(false)
  })
  it('an empty set hides nothing', () => {
    expect(edgeHidden({ source: 'a', target: 'b' }, new Set())).toBe(false)
  })
})
