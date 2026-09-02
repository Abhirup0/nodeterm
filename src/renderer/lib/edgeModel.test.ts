import { describe, it, expect } from 'vitest'
import {
  ROPE_NEUTRAL,
  dropAfterDep,
  edgeHidden,
  hiddenEdgeNodeIds,
  missingDepRopes,
  ropeInfoOf,
  ropeVisual,
  WAIT_LABEL,
  type RopeNodeInfo
} from './edgeModel'

const infoOf =
  (m: Record<string, RopeNodeInfo>) =>
  (id: string): RopeNodeInfo | undefined =>
    m[id]

describe('WAIT_LABEL', () => {
  it('is the one wording the waiting rope and its selected removal hint are both composed from', () => {
    // Canvas renders it bare while the rope is idle and as `${WAIT_LABEL} · ⌫ to stop waiting`
    // while it is selected, so the two sentences cannot drift apart (pinned in
    // canvas/edge-model.source.test.ts).
    expect(WAIT_LABEL).toBe('⏳ waits for')
  })
})

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

describe('ropeInfoOf — one endpoint lookup, shared by the render and the delete paths', () => {
  const colorOf = (a: string) => ({ claude: '#d97757', codex: '#10a37f' })[a]

  it('reports the node\'s agent colour through the injected registry', () => {
    const info = ropeInfoOf([{ id: 'a', data: { agentId: 'claude' } }], colorOf)
    expect(info('a')?.agentColor).toBe('#d97757')
  })

  it('a node with no agent has NO colour — ropeVisual is what falls back to the neutral', () => {
    const info = ropeInfoOf([{ id: 'a', data: {} }], colorOf)
    expect(info('a')).toEqual({ agentColor: undefined, pendingAfter: undefined })
    expect(ropeVisual({ source: 'a', target: 'b' }, info).color).toBe(ROPE_NEUTRAL)
  })

  it('an agent the registry does not know also has no colour (never a thrown lookup)', () => {
    const info = ropeInfoOf([{ id: 'a', data: { agentId: 'nobody' } }], colorOf)
    expect(info('a')?.agentColor).toBeUndefined()
  })

  it('passes pendingLaunch.after straight through, so a rope reads as waiting', () => {
    const info = ropeInfoOf(
      [{ id: 'a', data: { agentId: 'claude' } }, { id: 'b', data: { pendingLaunch: { after: ['a'], command: 'x' } } }],
      colorOf
    )
    expect(info('b')?.pendingAfter).toEqual(['a'])
    expect(ropeVisual({ source: 'a', target: 'b' }, info)).toEqual({ waiting: true, color: '#d97757' })
  })

  it('an id that is not on the canvas answers undefined', () => {
    expect(ropeInfoOf([{ id: 'a', data: {} }], colorOf)('ghost')).toBeUndefined()
  })
})

describe('missingDepRopes — a wait with no rope is a wait nothing on screen explains', () => {
  const armed = (id: string, after: string[]) => ({ id, data: { pendingLaunch: { after, command: 'go' } } })

  it('synthesizes dep -> node for an armed node whose rope was never written', () => {
    expect(missingDepRopes([{ id: 'a', data: {} }, armed('b', ['a'])], [])).toEqual([
      { id: 'ctrl-a-b', source: 'a', target: 'b' }
    ])
  })

  it('never duplicates a rope that already exists for that pair', () => {
    expect(missingDepRopes([{ id: 'a', data: {} }, armed('b', ['a'])], [{ source: 'a', target: 'b' }])).toEqual([])
  })

  it('an OPPOSITE rope is not the same relation — the dep rope is still owed', () => {
    expect(missingDepRopes([{ id: 'a', data: {} }, armed('b', ['a'])], [{ source: 'b', target: 'a' }])).toEqual([
      { id: 'ctrl-a-b', source: 'a', target: 'b' }
    ])
  })

  it('skips a dep that is not on the canvas (it can never report; the wait is already satisfied)', () => {
    expect(missingDepRopes([armed('b', ['ghost'])], [])).toEqual([])
  })

  it('a node that is not armed is owed nothing', () => {
    expect(missingDepRopes([{ id: 'a', data: {} }, { id: 'b', data: {} }], [])).toEqual([])
  })

  it('a repeated dep yields ONE rope — two edges with one id would be a React Flow collision', () => {
    expect(missingDepRopes([{ id: 'a', data: {} }, armed('b', ['a', 'a'])], [])).toEqual([
      { id: 'ctrl-a-b', source: 'a', target: 'b' }
    ])
  })
})
