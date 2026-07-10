import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import {
  reduceEntry,
  buildFile,
  recordAgentEvent,
  clearNode,
  flush,
  initAgentStatusMirror,
  _resetForTest,
  _snapshot,
  DONE_HOLDOFF_MS,
  EXPIRE_MS,
  type MirrorEntry
} from './agent-status-mirror'

// Minimal event factory — only the fields the reducer reads.
function ev(partial: Partial<NormalizedAgentEvent>): NormalizedAgentEvent {
  return { nodeId: 'n1', agentId: 'claude', kind: 'state', ...partial } as NormalizedAgentEvent
}

describe('reduceEntry (main-state reduction)', () => {
  it('reduces working → done and records the turn end', () => {
    const a = reduceEntry(undefined, ev({ kind: 'state', state: 'working', newTurn: true }), 1000)
    expect(a.state).toBe('working')
    expect(a.updatedAt).toBe(1000)
    const b = reduceEntry(a, ev({ kind: 'state', state: 'done' }), 2000)
    expect(b.state).toBe('done')
    expect(b.updatedAt).toBe(2000)
  })

  it('captures agentId + sessionId off any event', () => {
    const a = reduceEntry(undefined, ev({ agentId: 'codex', sessionId: 'sess-1', state: 'working' }), 1)
    expect(a.agentId).toBe('codex')
    expect(a.sessionId).toBe('sess-1')
  })

  it('holds done against a late non-newTurn working within the holdoff window', () => {
    const done: MirrorEntry = { state: 'done', agentId: 'claude', updatedAt: 5000 }
    const late = reduceEntry(done, ev({ kind: 'state', state: 'working' }), 5000 + DONE_HOLDOFF_MS - 1)
    expect(late.state).toBe('done')
    expect(late.updatedAt).toBe(5000) // timestamp not refreshed — holdoff keeps measuring from done
  })

  it('lets a genuine new turn override done inside the holdoff window', () => {
    const done: MirrorEntry = { state: 'done', agentId: 'claude', updatedAt: 5000 }
    const turn = reduceEntry(done, ev({ kind: 'state', state: 'working', newTurn: true }), 5000 + 1)
    expect(turn.state).toBe('working')
  })

  it('lets working resume after the holdoff window elapses', () => {
    const done: MirrorEntry = { state: 'done', agentId: 'claude', updatedAt: 5000 }
    const after = reduceEntry(done, ev({ kind: 'state', state: 'working' }), 5000 + DONE_HOLDOFF_MS + 1)
    expect(after.state).toBe('working')
  })

  it('subagent + recurring events do NOT clobber the main state', () => {
    let e: MirrorEntry = reduceEntry(undefined, ev({ kind: 'state', state: 'working' }), 1000)
    e = reduceEntry(e, ev({ kind: 'subagent-start', toolUseId: 't1', sessionId: 's9' }), 1100)
    expect(e.state).toBe('working')
    expect(e.sessionId).toBe('s9') // identity still captured
    e = reduceEntry(e, ev({ kind: 'subagent-end', toolUseId: 't1' }), 1200)
    expect(e.state).toBe('working')
    e = reduceEntry(e, ev({ kind: 'recurring', recurringKind: 'cron' }), 1300)
    expect(e.state).toBe('working')
    expect(e.updatedAt).toBe(1000) // identity-only events don't refresh state freshness
  })

  it('session start/end resets the node to idle', () => {
    const working = reduceEntry(undefined, ev({ kind: 'state', state: 'working' }), 1000)
    const started = reduceEntry(working, ev({ kind: 'session', sessionPhase: 'start' }), 2000)
    expect(started.state).toBeUndefined()
    const done = reduceEntry(started, ev({ kind: 'state', state: 'done' }), 3000)
    const ended = reduceEntry(done, ev({ kind: 'session', sessionPhase: 'end' }), 4000)
    expect(ended.state).toBeUndefined()
    expect(ended.agentId).toBe('claude') // identity preserved across reset
  })

  it('refreshes freshness on a same-state working (mid-turn tool events)', () => {
    const a = reduceEntry(undefined, ev({ kind: 'state', state: 'working' }), 1000)
    const b = reduceEntry(a, ev({ kind: 'state', state: 'working' }), 9000)
    expect(b.state).toBe('working')
    expect(b.updatedAt).toBe(9000)
  })
})

describe('buildFile (shape + expiry)', () => {
  it('produces the documented JSON shape', () => {
    const now = 10_000
    const doc = buildFile(
      { n1: { state: 'working', agentId: 'claude', sessionId: 's1', updatedAt: now } },
      now
    )
    expect(doc.v).toBe(1)
    expect(doc.updatedAt).toBe(now)
    expect(doc.nodes.n1).toEqual({
      state: 'working',
      agentId: 'claude',
      sessionId: 's1',
      updatedAt: now
    })
  })

  it('drops entries older than the expiry window', () => {
    const now = EXPIRE_MS + 100_000
    const doc = buildFile(
      {
        fresh: { state: 'working', updatedAt: now - 1000 },
        stale: { state: 'working', updatedAt: now - EXPIRE_MS - 1 }
      },
      now
    )
    expect(Object.keys(doc.nodes)).toEqual(['fresh'])
  })

  it('omits an undefined state (idle node keeps identity)', () => {
    const doc = buildFile({ n1: { agentId: 'claude', sessionId: 's1', updatedAt: 5 } }, 5)
    expect('state' in JSON.parse(JSON.stringify(doc)).nodes.n1).toBe(false)
    expect(JSON.parse(JSON.stringify(doc)).nodes.n1).toEqual({
      agentId: 'claude',
      sessionId: 's1',
      updatedAt: 5
    })
  })
})

describe('recordAgentEvent + atomic write', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    _resetForTest()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'))
    file = path.join(dir, 'agent-status.json')
    initAgentStatusMirror(file)
  })

  afterEach(() => {
    _resetForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('records events into memory and flushes valid JSON to disk', async () => {
    recordAgentEvent(ev({ nodeId: 'n1', state: 'working', sessionId: 's1' }))
    recordAgentEvent(ev({ nodeId: 'n1', state: 'done' }))
    expect(_snapshot().n1.state).toBe('done')

    await flush()
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(doc.v).toBe(1)
    expect(typeof doc.updatedAt).toBe('number')
    expect(doc.nodes.n1.state).toBe('done')
    expect(doc.nodes.n1.sessionId).toBe('s1')
    expect(doc.nodes.n1.agentId).toBe('claude')
  })

  it('writes the file with 0600 permissions', async () => {
    recordAgentEvent(ev({ state: 'working' }))
    await flush()
    const mode = fs.statSync(file).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('clearNode removes an entry from the written file', async () => {
    recordAgentEvent(ev({ nodeId: 'a', state: 'working' }))
    recordAgentEvent(ev({ nodeId: 'b', state: 'working' }))
    clearNode('a')
    await flush()
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(Object.keys(doc.nodes)).toEqual(['b'])
  })
})
