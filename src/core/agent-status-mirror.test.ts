import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import {
  reduceEntry,
  buildFile,
  filterMirrorForNodes,
  onMirrorFlush,
  recordAgentEvent,
  recordRawToolEvent,
  recordContextUsage,
  clearNode,
  flush,
  initAgentStatusMirror,
  setMirrorSettingsProvider,
  setMirrorUsageProvider,
  buildMirrorUsage,
  toolActivity,
  firstLine,
  extractQuestionOptions,
  onNodeStateChange,
  onNodeNowChange,
  _resetForTest,
  _snapshot,
  _inboxSnapshot,
  DONE_HOLDOFF_MS,
  EXPIRE_MS,
  INBOX_EVENTS_CAP,
  type MirrorEntry,
  type MirrorFile,
  type MirrorUsage,
  type NodeStateChange,
  type NodeNowChange
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

  it('onMirrorFlush delivers the built doc on every flush; unsubscribe stops it', async () => {
    const seen: MirrorFile[] = []
    const off = onMirrorFlush((doc) => seen.push(doc))
    recordAgentEvent(ev({ nodeId: 'n1', state: 'working' }))
    await flush()
    expect(seen).toHaveLength(1)
    expect(seen[0].nodes.n1.state).toBe('working')
    off()
    recordAgentEvent(ev({ nodeId: 'n1', state: 'done' }))
    await flush()
    expect(seen).toHaveLength(1)
  })

  it('onMirrorFlush still fires when the local disk write fails', async () => {
    initAgentStatusMirror(path.join(dir, 'no-such-dir', 'x', 'agent-status.json'))
    const seen: MirrorFile[] = []
    onMirrorFlush((doc) => seen.push(doc))
    recordAgentEvent(ev({ nodeId: 'n1', state: 'working' }))
    await flush()
    expect(seen).toHaveLength(1)
  })
})

describe('filterMirrorForNodes', () => {
  it('keeps only the given node ids, preserving header fields', () => {
    const doc: MirrorFile = {
      v: 1,
      updatedAt: 99,
      nodes: {
        a: { state: 'working', updatedAt: 1 },
        b: { state: 'done', updatedAt: 2 },
        c: { updatedAt: 3 }
      }
    }
    const out = filterMirrorForNodes(doc, new Set(['b', 'c', 'ghost']))
    expect(out.v).toBe(1)
    expect(out.updatedAt).toBe(99)
    expect(Object.keys(out.nodes).sort()).toEqual(['b', 'c'])
    expect(out.nodes.b.state).toBe('done')
  })

  it('does not mutate the input doc', () => {
    const doc: MirrorFile = { v: 1, updatedAt: 1, nodes: { a: { updatedAt: 1 } } }
    filterMirrorForNodes(doc, new Set())
    expect(Object.keys(doc.nodes)).toEqual(['a'])
  })
})

describe('settings block', () => {
  let tmpDir: string

  beforeEach(() => {
    _resetForTest()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-'))
  })

  afterEach(() => {
    _resetForTest()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('buildFile includes the settings block when given one', () => {
    const doc = buildFile({}, 1000, undefined, {
      claudePermissionMode: 'auto',
      autoSupported: true,
      claudeAccounts: [{ id: 'a1', dir: '/data/claude-accounts/a1' }]
    })
    expect(doc.settings).toEqual({
      claudePermissionMode: 'auto',
      autoSupported: true,
      claudeAccounts: [{ id: 'a1', dir: '/data/claude-accounts/a1' }]
    })
  })

  it('buildFile omits the settings key entirely when none given (old-file shape)', () => {
    const doc = buildFile({}, 1000)
    expect('settings' in doc).toBe(false)
  })

  it('filterMirrorForNodes drops settings from slices', () => {
    const doc = buildFile({}, 1000, undefined, { claudePermissionMode: 'plan' })
    expect('settings' in filterMirrorForNodes(doc, new Set())).toBe(false)
  })

  it('flush consults the provider at flush time', async () => {
    const file = path.join(tmpDir, 'status.json')
    initAgentStatusMirror(file)
    let mode = 'plan'
    setMirrorSettingsProvider(() => ({ claudePermissionMode: mode }))
    await flush()
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).settings.claudePermissionMode).toBe('plan')
    mode = 'acceptEdits'
    await flush()
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).settings.claudePermissionMode).toBe('acceptEdits')
  })

  it('a throwing provider fails open (no settings, file still written)', async () => {
    const file = path.join(tmpDir, 'status.json')
    initAgentStatusMirror(file)
    setMirrorSettingsProvider(() => { throw new Error('boom') })
    await flush()
    expect('settings' in JSON.parse(fs.readFileSync(file, 'utf-8'))).toBe(false)
  })
})

// ---- mobile-usage-inbox ---------------------------------------------------------------------

describe('inbox event production (via recordAgentEvent)', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('emits an approval on blocked and dedups a same-title re-assertion', () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write to /etc/hosts' }))
    let ib = _inboxSnapshot()
    expect(ib.events).toHaveLength(1)
    expect(ib.events[0].kind).toBe('approval')
    expect(ib.events[0].title).toBe('Approve write to /etc/hosts')
    expect(ib.events[0].resolved).toBeUndefined()
    // Same blocked ask again (still blocked) → deduped, no second event.
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write to /etc/hosts' }))
    expect(_inboxSnapshot().events).toHaveLength(1)
    // A genuinely different ask while still blocked DOES land.
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve rm -rf /tmp/x' }))
    ib = _inboxSnapshot()
    expect(ib.events).toHaveLength(2)
    expect(ib.events[1].title).toBe('Approve rm -rf /tmp/x')
  })

  it('carries the deterministic-approval pendingId onto the approval event (and omits it when absent)', () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write', pendingId: 'n1-123-9' }))
    const withId = _inboxSnapshot().events[0]
    expect(withId.kind).toBe('approval')
    expect(withId.pendingId).toBe('n1-123-9')

    // A different node whose hook did NOT arm the wait (no pendingId) → the field is omitted.
    recordAgentEvent(ev({ nodeId: 'other', state: 'blocked', lastMessage: 'Approve?' }))
    const noId = _inboxSnapshot().events.find((e) => e.nodeId === 'other')!
    expect(noId.kind).toBe('approval')
    expect('pendingId' in noId).toBe(false)
  })

  it('titles blocked/waiting from lastMessage first line, with fallbacks', () => {
    recordAgentEvent(ev({ nodeId: 'a', state: 'blocked' }))
    recordAgentEvent(ev({ nodeId: 'b', state: 'waiting' }))
    recordAgentEvent(ev({ nodeId: 'c', state: 'waiting', lastMessage: 'Which file?\nsecond line' }))
    const ev3 = _inboxSnapshot().events
    expect(ev3.find((e) => e.nodeId === 'a')!.title).toBe('Needs approval')
    expect(ev3.find((e) => e.nodeId === 'b')!.title).toBe('Waiting for input')
    const q = ev3.find((e) => e.nodeId === 'c')!
    expect(q.kind).toBe('question')
    expect(q.title).toBe('Which file?')
  })

  it('resolves unresolved approval/question when the node leaves blocked/waiting', () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve?' }))
    expect(_inboxSnapshot().events[0].resolved).toBeUndefined()
    recordAgentEvent(ev({ state: 'working' })) // left blocked
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
  })

  it('session reset also resolves a pending question', () => {
    recordAgentEvent(ev({ state: 'waiting', lastMessage: 'Pick one' }))
    recordAgentEvent(ev({ kind: 'session', sessionPhase: 'end' }))
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
  })

  it('emits one done per turn with a detail snippet and passes interrupted through', () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'done', lastMessage: 'All wired up.\nplus extra' }))
    let ib = _inboxSnapshot()
    expect(ib.events).toHaveLength(1)
    expect(ib.events[0]).toMatchObject({ kind: 'done', title: 'Finished', detail: 'All wired up.' })
    expect(ib.events[0].interrupted).toBeUndefined()
    // A duplicate done (no new turn) does not append a second event.
    recordAgentEvent(ev({ state: 'done' }))
    expect(_inboxSnapshot().events).toHaveLength(1)
    // A new turn that ends interrupted titles "Stopped".
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'done', interrupted: true }))
    ib = _inboxSnapshot()
    expect(ib.events).toHaveLength(2)
    expect(ib.events[1]).toMatchObject({ kind: 'done', title: 'Stopped', interrupted: true })
  })

  it('caps the feed at INBOX_EVENTS_CAP, dropping oldest', () => {
    const total = INBOX_EVENTS_CAP + 10
    for (let i = 0; i < total; i++) {
      recordAgentEvent(ev({ state: 'working', newTurn: true }))
      recordAgentEvent(ev({ state: 'done', lastMessage: `turn ${i}` }))
    }
    const events = _inboxSnapshot().events
    expect(events).toHaveLength(INBOX_EVENTS_CAP)
    // The newest survives, the earliest fell off the front.
    expect(events[events.length - 1].detail).toBe(`turn ${total - 1}`)
    expect(events[0].detail).toBe(`turn ${total - INBOX_EVENTS_CAP}`)
  })

  it('clearNode drops the node activity but keeps its events, marked resolved', () => {
    recordAgentEvent(ev({ nodeId: 'x', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'x', state: 'blocked', lastMessage: 'Q' }))
    recordContextUsage('x', 40)
    clearNode('x')
    const ib = _inboxSnapshot()
    expect(ib.nodes.x).toBeUndefined()
    expect(ib.events).toHaveLength(1)
    expect(ib.events[0].resolved).toBe(true)
  })
})

describe('activity mapping (toolActivity + recordRawToolEvent)', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('maps each tool to its activity line', () => {
    expect(toolActivity('Edit', { file_path: '/a/b/foo.ts' })).toBe('Editing foo.ts')
    expect(toolActivity('Write', { file_path: 'x/bar.py' })).toBe('Editing bar.py')
    expect(toolActivity('NotebookEdit', { notebook_path: '/n/nb.ipynb' })).toBe('Editing nb.ipynb')
    expect(toolActivity('Read', { file_path: '/a/baz.md' })).toBe('Reading baz.md')
    expect(toolActivity('Bash', { command: 'npm test' })).toBe('Running npm test')
    expect(toolActivity('Grep', { pattern: 'foo.*bar' })).toBe('Searching foo.*bar')
    expect(toolActivity('Glob', { pattern: '**/*.ts' })).toBe('Searching **/*.ts')
    expect(toolActivity('Task', { description: 'refactor auth' })).toBe('Delegating: refactor auth')
    expect(toolActivity('WebFetch', { url: 'https://example.com/x?q=1' })).toBe('Fetching example.com')
    expect(toolActivity('WebSearch', { query: 'weather today' })).toBe('Fetching weather today')
    expect(toolActivity('CustomThing', {})).toBe('Using CustomThing')
  })

  it('truncates a long Bash command', () => {
    const long = 'echo ' + 'a'.repeat(200)
    const out = toolActivity('Bash', { command: long })
    expect(out.startsWith('Running ')).toBe(true)
    expect(out.length).toBeLessThanOrEqual('Running '.length + 60)
    expect(out.endsWith('…')).toBe(true)
  })

  it('records activity on PreToolUse and clears it on Stop/SessionEnd', () => {
    recordRawToolEvent('n1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' } })
    expect(_inboxSnapshot().nodes.n1).toMatchObject({ activity: 'Running ls -la', tool: 'Bash' })
    recordRawToolEvent('n1', { hook_event_name: 'Stop' })
    expect(_inboxSnapshot().nodes.n1.activity).toBeUndefined()

    recordRawToolEvent('n2', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.ts' } })
    recordRawToolEvent('n2', { hook_event_name: 'SessionEnd' })
    expect(_inboxSnapshot().nodes.n2.activity).toBeUndefined()
  })

  it('a done event clears live activity but keeps context %', () => {
    recordRawToolEvent('n3', { hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' } })
    recordContextUsage('n3', 30)
    expect(_inboxSnapshot().nodes.n3).toMatchObject({ activity: 'Searching x', contextPercent: 30 })
    recordAgentEvent(ev({ nodeId: 'n3', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n3', state: 'done' }))
    const n3 = _inboxSnapshot().nodes.n3
    expect(n3.activity).toBeUndefined()
    expect(n3.contextPercent).toBe(30)
  })

  it('recordContextUsage clamps to 0–100 and coexists with activity', () => {
    recordContextUsage('c', 42.5)
    expect(_inboxSnapshot().nodes.c.contextPercent).toBe(42.5)
    recordContextUsage('c', 150)
    expect(_inboxSnapshot().nodes.c.contextPercent).toBe(100)
    recordRawToolEvent('c', { hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: '*.md' } })
    expect(_inboxSnapshot().nodes.c).toMatchObject({ activity: 'Searching *.md', contextPercent: 100 })
  })

  it('firstLine takes the first non-empty line and clips', () => {
    expect(firstLine('  \n\n hello there \nmore', 100)).toBe('hello there')
    expect(firstLine('abcdefghij', 5)).toBe('abcd…')
    expect(firstLine(undefined, 10)).toBe('')
  })
})

// ---- interactive-push-live-activities -------------------------------------------------------

describe('question options (AskUserQuestion)', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  const q1 = (opts: unknown[]) => ({ questions: [{ options: opts }] })

  it('extracts ≤4 labels clipped to 60, first question only, fail-open on bad shape', () => {
    expect(extractQuestionOptions(q1([{ label: 'Dark' }, { label: 'Light' }]))).toEqual(['Dark', 'Light'])
    // clips each label to 60
    const long = 'x'.repeat(100)
    expect(extractQuestionOptions(q1([{ label: long }]))![0]).toBe('x'.repeat(59) + '…')
    // caps at 4
    expect(extractQuestionOptions(q1([1, 2, 3, 4, 5].map((n) => ({ label: `o${n}` })))))
      .toEqual(['o1', 'o2', 'o3', 'o4'])
    // only the FIRST question's options
    expect(
      extractQuestionOptions({ questions: [{ options: [{ label: 'A' }] }, { options: [{ label: 'B' }] }] })
    ).toEqual(['A'])
    // fail-open on every shape mismatch
    expect(extractQuestionOptions(undefined)).toBeUndefined()
    expect(extractQuestionOptions({})).toBeUndefined()
    expect(extractQuestionOptions({ questions: [] })).toBeUndefined()
    expect(extractQuestionOptions(q1([]))).toBeUndefined()
    expect(extractQuestionOptions(q1([{ nope: 1 }]))).toBeUndefined()
    expect(extractQuestionOptions({ questions: 'x' } as unknown as Record<string, unknown>)).toBeUndefined()
  })

  it('stashes options on the raw AskUserQuestion hook and attaches them to the next question', () => {
    recordRawToolEvent('n1', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: q1([{ label: 'Dark' }, { label: 'Light' }, { label: 'System' }])
    })
    recordAgentEvent(ev({ nodeId: 'n1', state: 'waiting', lastMessage: 'Pick a theme' }))
    const q = _inboxSnapshot().events.find((e) => e.nodeId === 'n1' && e.kind === 'question')!
    expect(q.options).toEqual(['Dark', 'Light', 'System'])
  })

  it('a plain question (no AskUserQuestion) carries no options', () => {
    recordAgentEvent(ev({ nodeId: 'n2', state: 'waiting', lastMessage: 'Which file?' }))
    expect(_inboxSnapshot().events.find((e) => e.nodeId === 'n2')!.options).toBeUndefined()
  })

  it('approvals never carry options even when a stash exists', () => {
    recordRawToolEvent('n3', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: q1([{ label: 'A' }])
    })
    recordAgentEvent(ev({ nodeId: 'n3', state: 'blocked', lastMessage: 'Approve?' }))
    const e = _inboxSnapshot().events.find((x) => x.nodeId === 'n3')!
    expect(e.kind).toBe('approval')
    expect(e.options).toBeUndefined()
  })

  it('clears the stash when the node leaves waiting (no reuse on a later question)', () => {
    recordRawToolEvent('n4', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: q1([{ label: 'A' }])
    })
    recordAgentEvent(ev({ nodeId: 'n4', state: 'waiting', lastMessage: 'Q1' }))
    recordAgentEvent(ev({ nodeId: 'n4', state: 'working' })) // leaves waiting → clears stash
    recordAgentEvent(ev({ nodeId: 'n4', state: 'waiting', lastMessage: 'Q2' }))
    const qs = _inboxSnapshot().events.filter((e) => e.nodeId === 'n4' && e.kind === 'question')
    expect(qs[qs.length - 1].options).toBeUndefined()
  })

  it('clears the stash on a new turn', () => {
    recordRawToolEvent('n5', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: q1([{ label: 'A' }])
    })
    recordAgentEvent(ev({ nodeId: 'n5', state: 'working', newTurn: true })) // new turn clears
    recordAgentEvent(ev({ nodeId: 'n5', state: 'waiting', lastMessage: 'Q' }))
    expect(_inboxSnapshot().events.find((e) => e.nodeId === 'n5' && e.kind === 'question')!.options).toBeUndefined()
  })
})

describe('onNodeStateChange seam', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('fires start on working, needsYou on blocked/waiting, end on done — with the mapped messages', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write' }))
    recordAgentEvent(ev({ state: 'working' })) // resume — an edge back into working
    recordAgentEvent(ev({ state: 'done', lastMessage: 'Wrapped up.' }))
    expect(seen.map((c) => [c.event, c.state])).toEqual([
      ['start', 'working'],
      ['update', 'needsYou'],
      ['start', 'working'],
      ['end', 'done']
    ])
    expect(seen[1].message).toBe('Approve write')
    expect(seen[3].message).toBe('Finished')
  })

  it('maps waiting to needsYou and titles interrupted done "Stopped"', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ nodeId: 'q', state: 'waiting', lastMessage: 'Which one?' }))
    recordAgentEvent(ev({ nodeId: 'q', state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'q', state: 'done', interrupted: true }))
    expect(seen.find((c) => c.state === 'needsYou')!.message).toBe('Which one?')
    expect(seen.find((c) => c.state === 'done')!.message).toBe('Stopped')
  })

  it('does not refire start for a same-state working tick, nor needsYou for a re-asserted blocked', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'working' })) // tool tick
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'A' }))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'A' })) // re-assert
    expect(seen.filter((c) => c.event === 'start')).toHaveLength(1)
    expect(seen.filter((c) => c.state === 'needsYou')).toHaveLength(1)
  })

  it('does not fire a start for a held-off late working (done-holdoff)', () => {
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'done' }))
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    // A late, non-newTurn working within DONE_HOLDOFF_MS is held off by reduceEntry → no start.
    recordAgentEvent(ev({ state: 'working' }))
    expect(seen.filter((c) => c.event === 'start')).toHaveLength(0)
  })

  it('the needsYou edge into blocked carries kind:approval + the pendingId (from the approval event)', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write', pendingId: 'n1-123-9' }))
    const ny = seen.find((c) => c.state === 'needsYou')!
    expect(ny.kind).toBe('approval')
    expect(ny.pendingId).toBe('n1-123-9')
    expect('options' in ny).toBe(false)
  })

  it('an approval edge whose hook did not arm a wait omits pendingId (still kind:approval)', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Approve write' }))
    const ny = seen.find((c) => c.state === 'needsYou')!
    expect(ny.kind).toBe('approval')
    expect('pendingId' in ny).toBe(false)
  })

  it('the needsYou edge into waiting carries kind:question + the stashed AskUserQuestion options', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordRawToolEvent('n1', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ options: [{ label: 'Dark' }, { label: 'Light' }, { label: 'System' }] }] }
    })
    recordAgentEvent(ev({ state: 'waiting', lastMessage: 'Pick a theme' }))
    const ny = seen.find((c) => c.state === 'needsYou')!
    expect(ny.kind).toBe('question')
    expect(ny.options).toEqual(['Dark', 'Light', 'System'])
    expect('pendingId' in ny).toBe(false)
  })

  it('a plain waiting edge (no AskUserQuestion stash) is kind:question with no options', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ state: 'waiting', lastMessage: 'Which one?' }))
    const ny = seen.find((c) => c.state === 'needsYou')!
    expect(ny.kind).toBe('question')
    expect('options' in ny).toBe(false)
  })

  it('working and done edges carry no kind/options/pendingId', () => {
    const seen: NodeStateChange[] = []
    onNodeStateChange((c) => seen.push(c))
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'done', lastMessage: 'Wrapped up.' }))
    for (const c of seen) {
      expect('kind' in c).toBe(false)
      expect('options' in c).toBe(false)
      expect('pendingId' in c).toBe(false)
    }
  })
})

describe('onNodeNowChange seam', () => {
  beforeEach(() => _resetForTest())
  afterEach(() => _resetForTest())

  it('fires on an activity change and on a context change', () => {
    const seen: NodeNowChange[] = []
    onNodeNowChange((c) => seen.push(c))
    recordRawToolEvent('n1', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })
    recordContextUsage('n1', 55)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ nodeId: 'n1', activity: 'Running ls' })
    expect(seen[1]).toMatchObject({ nodeId: 'n1', contextPercent: 55 })
  })

  it('fires with activity undefined when a Stop clears the line', () => {
    const seen: NodeNowChange[] = []
    recordRawToolEvent('n2', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.ts' } })
    onNodeNowChange((c) => seen.push(c))
    recordRawToolEvent('n2', { hook_event_name: 'Stop' })
    expect(seen).toHaveLength(1)
    expect(seen[0].activity).toBeUndefined()
  })
})

describe('buildMirrorUsage', () => {
  it('maps snapshots to accounts, system first, with defensive limit fields + labels', () => {
    const snap = [
      {
        accountId: null,
        usage: {
          email: 'sys@x',
          updatedAt: 100,
          status: 'ok',
          limits: [{ kind: 'session', usedPercent: 20, severity: 'normal', resetsAt: 999 }]
        }
      },
      {
        accountId: 'a1',
        usage: { email: null, updatedAt: 200, status: 'ok', limits: [{ kind: 'weekly_all', usedPercent: 80 }] }
      }
    ]
    const mu = buildMirrorUsage(snap, [{ id: 'a1', label: 'Work', email: 'work@x' }], 500)!
    expect(mu.accounts[0].accountId).toBeNull()
    expect(mu.accounts[0].label).toBeNull()
    expect(mu.accounts[0].email).toBe('sys@x')
    expect(mu.accounts[0].agentId).toBe('claude')
    expect(mu.accounts[0].limits[0]).toEqual({
      kind: 'session',
      group: null,
      usedPercent: 20,
      severity: 'normal',
      resetsAt: 999,
      windowMinutes: null,
      scopeLabel: null,
      isActive: false
    })
    // Managed account: label from settings, email backfilled from settings when usage has none,
    // and its limit's absent severity passes through as null (not defaulted to a colour).
    expect(mu.accounts[1]).toMatchObject({ accountId: 'a1', label: 'Work', email: 'work@x' })
    expect(mu.accounts[1].limits[0].severity).toBeNull()
    // updatedAt is the freshest account's stamp.
    expect(mu.updatedAt).toBe(200)
  })

  it('orders the system account first regardless of snapshot order', () => {
    const snap = [
      { accountId: 'a1', usage: { status: 'ok', limits: [] } },
      { accountId: null, usage: { status: 'ok', limits: [] } }
    ]
    const mu = buildMirrorUsage(snap, [], 9)!
    expect(mu.accounts.map((a) => a.accountId)).toEqual([null, 'a1'])
  })

  it('returns undefined for an empty snapshot', () => {
    expect(buildMirrorUsage([], [], 5)).toBeUndefined()
  })
})

describe('usage block on flush', () => {
  let tmpDir: string
  let file: string

  beforeEach(() => {
    _resetForTest()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-status-usage-'))
    file = path.join(tmpDir, 'status.json')
    initAgentStatusMirror(file)
  })
  afterEach(() => {
    _resetForTest()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes the usage block from the provider', async () => {
    const usage: MirrorUsage = {
      updatedAt: 5,
      accounts: [
        { accountId: null, label: null, email: 'e', agentId: 'claude', status: 'ok', updatedAt: 5, limits: [] }
      ]
    }
    setMirrorUsageProvider(() => usage)
    await flush()
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(doc.usage.accounts[0].email).toBe('e')
  })

  it('omits usage when no provider is wired (old-file shape)', async () => {
    await flush()
    expect('usage' in JSON.parse(fs.readFileSync(file, 'utf-8'))).toBe(false)
  })

  it('a throwing usage provider fails open (no usage, file still written)', async () => {
    setMirrorUsageProvider(() => { throw new Error('boom') })
    recordAgentEvent(ev({ state: 'working' }))
    await flush()
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect('usage' in doc).toBe(false)
    expect(doc.nodes.n1.state).toBe('working')
  })
})

describe('filterMirrorForNodes (usage + inbox)', () => {
  it('drops usage entirely and filters inbox events + nodes to the slice', () => {
    const doc = buildFile(
      { a: { state: 'working', updatedAt: 1 }, b: { state: 'done', updatedAt: 2 } },
      10,
      undefined,
      undefined,
      {
        updatedAt: 5,
        accounts: [
          { accountId: null, label: null, email: null, agentId: 'claude', status: 'ok', updatedAt: 5, limits: [] }
        ]
      },
      {
        events: [
          { id: '1', ts: 1, nodeId: 'a', kind: 'approval', title: 'A' },
          { id: '2', ts: 2, nodeId: 'b', kind: 'done', title: 'Finished' }
        ],
        nodes: { a: { activity: 'x', updatedAt: 1 }, b: { activity: 'y', updatedAt: 2 } }
      }
    )
    expect('usage' in doc).toBe(true)
    const slice = filterMirrorForNodes(doc, new Set(['a']))
    expect('usage' in slice).toBe(false)
    expect(slice.inbox!.events.map((e) => e.nodeId)).toEqual(['a'])
    expect(Object.keys(slice.inbox!.nodes)).toEqual(['a'])
  })

  it('buildFile omits an empty inbox (old-file shape preserved)', () => {
    const d = buildFile({}, 1, undefined, undefined, undefined, { events: [], nodes: {} })
    expect('inbox' in d).toBe(false)
  })
})
