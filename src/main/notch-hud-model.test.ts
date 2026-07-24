import { describe, it, expect } from 'vitest'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import type { NodeStateChange, NodeNowChange, MirrorFile } from '../core/agent-status-mirror'
import {
  createHudModel,
  bucketState,
  firstPromptLine,
  buildIndicator,
  HUD_STALE_DROP_MS,
  type HudRow
} from './notch-hud-model'

const T0 = 1_000_000

function stateChange(p: Partial<NodeStateChange> & { nodeId: string; state: NodeStateChange['state'] }): NodeStateChange {
  return { event: 'update', ts: T0, ...p }
}
function nowChange(p: Partial<NodeNowChange> & { nodeId: string }): NodeNowChange {
  return { ts: T0, ...p }
}
function titleOf(id: string): string {
  return `title-${id}`
}
function rowFor(rows: HudRow[], nodeId: string): HudRow | undefined {
  return rows.find((r) => r.nodeId === nodeId)
}

describe('bucketState', () => {
  it('collapses waiting/blocked to needsYou, keeps working/done', () => {
    expect(bucketState('working')).toBe('working')
    expect(bucketState('done')).toBe('done')
    expect(bucketState('waiting')).toBe('needsYou')
    expect(bucketState('blocked')).toBe('needsYou')
  })
})

describe('firstPromptLine', () => {
  it('returns the first non-empty trimmed line and clips long ones', () => {
    expect(firstPromptLine('\n\n  hello world  \nsecond')).toBe('hello world')
    expect(firstPromptLine(undefined)).toBeUndefined()
    expect(firstPromptLine('   ')).toBeUndefined()
    const long = 'x'.repeat(300)
    const clipped = firstPromptLine(long, 10)!
    expect(clipped.length).toBe(10)
    expect(clipped.endsWith('…')).toBe(true)
  })
})

describe('createHudModel — state → bucket', () => {
  it('maps working/needsYou/done edges into rows and drops idle', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working', agentId: 'claude' }))
    m.applyStateChange(stateChange({ nodeId: 'b', state: 'needsYou', agentId: 'codex' }))
    let rows = m.buildRows(T0, titleOf)
    expect(rowFor(rows, 'a')?.state).toBe('working')
    expect(rowFor(rows, 'a')?.title).toBe('title-a')
    expect(rowFor(rows, 'b')?.state).toBe('needsYou')

    // done then acknowledged → demotes to idle → drops out of the row list
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'done' }))
    rows = m.buildRows(T0, titleOf)
    expect(rowFor(rows, 'a')?.state).toBe('done')
    m.noteFocus('a')
    rows = m.buildRows(T0, titleOf)
    expect(rowFor(rows, 'a')).toBeUndefined()
  })

  it('mirror flush maps waiting/blocked to needsYou and seeds unseen nodes', () => {
    const m = createHudModel()
    const doc: MirrorFile = {
      v: 1,
      updatedAt: T0,
      nodes: {
        w: { state: 'working', agentId: 'claude', updatedAt: T0 },
        q: { state: 'waiting', agentId: 'gemini', updatedAt: T0 },
        x: { state: 'blocked', agentId: 'codex', updatedAt: T0 }
      }
    }
    m.applyMirrorFlush(doc)
    const rows = m.buildRows(T0, titleOf)
    expect(rowFor(rows, 'w')?.state).toBe('working')
    expect(rowFor(rows, 'q')?.state).toBe('needsYou')
    expect(rowFor(rows, 'x')?.state).toBe('needsYou')
  })
})

describe('done latch', () => {
  it('is cleared by noteFocus and by notePanelOpened', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'done' }))
    m.applyStateChange(stateChange({ nodeId: 'b', state: 'done' }))
    expect(rowFor(m.buildRows(T0, titleOf), 'a')?.state).toBe('done')
    m.noteFocus('a')
    expect(rowFor(m.buildRows(T0, titleOf), 'a')).toBeUndefined()
    expect(rowFor(m.buildRows(T0, titleOf), 'b')?.state).toBe('done')
    m.notePanelOpened()
    expect(rowFor(m.buildRows(T0, titleOf), 'b')).toBeUndefined()
  })

  it('an explicit read-ack end does not raise the highlight', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'done', ack: true }))
    // already-seen done → idle → not shown
    expect(rowFor(m.buildRows(T0, titleOf), 'a')).toBeUndefined()
  })

  it('a fresh working edge re-arms a previously seen done', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'done' }))
    m.noteFocus('a')
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working' }))
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'done', ts: T0 + 1 }))
    expect(rowFor(m.buildRows(T0 + 1, titleOf), 'a')?.state).toBe('done')
  })
})

describe('subagent grouping', () => {
  const evt = (p: Partial<NormalizedAgentEvent> & { nodeId: string; kind: NormalizedAgentEvent['kind'] }): NormalizedAgentEvent =>
    ({ agentId: 'claude', ...p } as NormalizedAgentEvent)

  it('groups subagent start/end under the node and marks done', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working', agentId: 'claude' }))
    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'subagent-start', toolUseId: 't1', taskLabel: 'do-x' }))
    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'subagent-start', toolUseId: 't2', subagentType: 'general' }))
    let row = rowFor(m.buildRows(T0, titleOf), 'a')!
    expect(row.subagents).toHaveLength(2)
    expect(row.subagents.find((s) => s.id === 't1')?.label).toBe('do-x')
    expect(row.subagents.find((s) => s.id === 't2')?.label).toBe('general')

    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'subagent-end', toolUseId: 't1' }))
    row = rowFor(m.buildRows(T0, titleOf), 'a')!
    expect(row.subagents.find((s) => s.id === 't1')?.state).toBe('done')
    expect(row.subagents.find((s) => s.id === 't2')?.state).toBe('working')
  })

  it('clears fan-out on a new turn and captures the prompt', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working', agentId: 'claude' }))
    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'subagent-start', toolUseId: 't1' }))
    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'state', newTurn: true, task: 'refactor the parser\nmore' }))
    const row = rowFor(m.buildRows(T0, titleOf), 'a')!
    expect(row.subagents).toHaveLength(0)
    expect(row.prompt).toBe('refactor the parser')
  })

  it('clears fan-out on session end', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working' }))
    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'subagent-start', toolUseId: 't1' }))
    m.applyAgentEvent(evt({ nodeId: 'a', kind: 'session', sessionPhase: 'end' }))
    expect(rowFor(m.buildRows(T0, titleOf), 'a')!.subagents).toHaveLength(0)
  })
})

describe('prompt / model / context join', () => {
  it('joins model by sessionId and context% by now-change', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working', agentId: 'claude', sessionId: 's1' }))
    m.applyContextUpdate({ sessionId: 's1', model: 'claude-opus-4', usedPercent: 42 })
    m.applyNowChange(nowChange({ nodeId: 'a', activity: 'Editing file.ts' }))
    const row = rowFor(m.buildRows(T0, titleOf), 'a')!
    expect(row.model).toBe('claude-opus-4')
    expect(row.contextPercent).toBe(42)
    expect(row.activity).toBe('Editing file.ts')
  })
})

describe('6h drop', () => {
  it('drops a gone + idle node after 6h, keeps a present or recent one', () => {
    const m = createHudModel()
    // present in mirror → never dropped, even if stale
    m.applyMirrorFlush({ v: 1, updatedAt: T0, nodes: { present: { state: 'done', updatedAt: T0 } } })
    // gone node, recently done
    m.applyStateChange(stateChange({ nodeId: 'gone', state: 'done', ts: T0 }))
    // it's not in the mirror flush above → presentInMirror stays false

    expect(m.prune(T0 + HUD_STALE_DROP_MS - 1)).toBe(false)
    // still around, seen check: build after prune
    // now push past 6h
    expect(m.prune(T0 + HUD_STALE_DROP_MS + 1)).toBe(true)
    const rows = m.buildRows(T0 + HUD_STALE_DROP_MS + 1, titleOf)
    expect(rowFor(rows, 'gone')).toBeUndefined()
    // present node still tracked (done, unseen)
    expect(rowFor(rows, 'present')?.state).toBe('done')
  })

  it('never drops a working node', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'w', state: 'working', ts: T0 }))
    expect(m.prune(T0 + HUD_STALE_DROP_MS + 1)).toBe(false)
    expect(rowFor(m.buildRows(T0 + HUD_STALE_DROP_MS + 1, titleOf), 'w')?.state).toBe('working')
  })
})

describe('buildIndicator + ordering', () => {
  it('lists distinct working agents and flags done-unseen', () => {
    const m = createHudModel()
    m.applyStateChange(stateChange({ nodeId: 'a', state: 'working', agentId: 'claude', ts: T0 + 1 }))
    m.applyStateChange(stateChange({ nodeId: 'b', state: 'working', agentId: 'codex', ts: T0 + 2 }))
    m.applyStateChange(stateChange({ nodeId: 'c', state: 'working', agentId: 'claude', ts: T0 + 3 }))
    m.applyStateChange(stateChange({ nodeId: 'd', state: 'done', agentId: 'gemini', ts: T0 + 4 }))
    const rows = m.buildRows(T0 + 10, titleOf)
    // newest-active first
    expect(rows.map((r) => r.nodeId)).toEqual(['d', 'c', 'b', 'a'])
    const ind = buildIndicator(rows)
    expect(ind.workingAgents.sort()).toEqual(['claude', 'codex'])
    expect(ind.doneUnseen).toBe(true)
  })
})
