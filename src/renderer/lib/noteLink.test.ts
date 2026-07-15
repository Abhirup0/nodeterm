import { describe, it, expect } from 'vitest'
import {
  buildBackgroundLinkMaps,
  buildCanvasControlNote,
  buildContextLinkNote,
  buildLinkMap,
  buildNotePushMessage,
  classifyLink,
  shouldPushControlNote
} from './noteLink'
import type { CanvasNodeState } from '@shared/types'

const term = (contextCapable = false) => ({ kind: 'terminal', contextCapable })
const sticky = () => ({ kind: 'sticky', contextCapable: false })

describe('classifyLink', () => {
  it('two context-capable terminals form a context link', () => {
    expect(classifyLink(term(true), term(true))).toBe('context')
  })
  it('terminals that are not both context-capable form nothing', () => {
    expect(classifyLink(term(true), term(false))).toBeNull()
    expect(classifyLink(term(false), term(false))).toBeNull()
  })
  it('sticky ↔ terminal forms a note link in either direction', () => {
    expect(classifyLink(sticky(), term(false))).toBe('note')
    expect(classifyLink(term(true), sticky())).toBe('note')
  })
  it('sticky ↔ sticky and sticky ↔ non-terminal form nothing', () => {
    expect(classifyLink(sticky(), sticky())).toBeNull()
    expect(classifyLink(sticky(), { kind: 'editor', contextCapable: false })).toBeNull()
  })
})

describe('buildNotePushMessage', () => {
  it('wraps the note text with the nodeterm prefix and title', () => {
    expect(buildNotePushMessage('Deploy notes', 'use the staging key')).toBe(
      '[nodeterm] Sticky note "Deploy notes" linked as context: use the staging key'
    )
  })
  it('returns null for empty or whitespace-only text', () => {
    expect(buildNotePushMessage('T', '')).toBeNull()
    expect(buildNotePushMessage('T', '  \n ')).toBeNull()
  })
  it('collapses newlines so the message stays single-line', () => {
    const msg = buildNotePushMessage('T', 'line one\nline two\r\nline three')
    expect(msg).toContain('line one ⏎ line two ⏎ line three')
    expect(msg).not.toContain('\n')
  })
  it('truncates past 2000 chars and points at the skill', () => {
    const msg = buildNotePushMessage('T', 'x'.repeat(3000))!
    expect(msg.length).toBeLessThan(2200)
    expect(msg).toContain('[truncated — read the full note with the get-linked-context skill]')
  })
})

describe('buildLinkMap', () => {
  const infoOf = (id: string) =>
    id.startsWith('note')
      ? { id, title: `Note ${id}`, note: `text of ${id}`, sticky: true }
      : { id, title: `Term ${id}`, cwd: `/cwd/${id}`, sticky: false }

  it('context edges map both directions with cwd', () => {
    const map = buildLinkMap([{ source: 'a', target: 'b' }], infoOf)
    expect(map).toEqual({
      a: [{ id: 'b', title: 'Term b', cwd: '/cwd/b' }],
      b: [{ id: 'a', title: 'Term a', cwd: '/cwd/a' }]
    })
  })
  it('note edges map one direction only: terminal gets the note entry', () => {
    const map = buildLinkMap(
      [
        { source: 'note1', target: 't1' },
        { source: 't2', target: 'note1' }
      ],
      infoOf
    )
    expect(map).toEqual({
      t1: [{ id: 'note1', title: 'Note note1', note: 'text of note1' }],
      t2: [{ id: 'note1', title: 'Note note1', note: 'text of note1' }]
    })
    expect(map['note1']).toBeUndefined()
  })
  it('an empty sticky still yields an entry with empty note', () => {
    const map = buildLinkMap([{ source: 'noteX', target: 't1' }], (id) =>
      id === 'noteX' ? { id, title: 'N', sticky: true } : { id, title: 'T', cwd: '', sticky: false }
    )
    expect(map['t1']).toEqual([{ id: 'noteX', title: 'N', note: '' }])
  })
})

describe('buildLinkMap agent identity', () => {
  it('carries agentId/sessionId/accountId on context entries', () => {
    const infoOf = (id: string) => ({
      id,
      title: `T ${id}`,
      cwd: '',
      sticky: false,
      agentId: id === 'a' ? 'claude' : 'codex',
      sessionId: `sess-${id}`,
      accountId: id === 'a' ? 'acct-1' : undefined
    })
    const map = buildLinkMap([{ source: 'a', target: 'b' }], infoOf)
    expect(map['a'][0]).toMatchObject({ id: 'b', agentId: 'codex', sessionId: 'sess-b' })
    expect(map['a'][0].accountId).toBeUndefined()
    expect(map['b'][0]).toMatchObject({ id: 'a', agentId: 'claude', sessionId: 'sess-a', accountId: 'acct-1' })
  })
})

describe('buildContextLinkNote', () => {
  it('claude gets the skill wording', () => {
    const msg = buildContextLinkNote('claude', 'Builder', '/x/context.sh')
    expect(msg).toContain('[nodeterm] You are now linked to "Builder"')
    expect(msg).toContain('get-linked-context skill')
  })
  it('codex/gemini get the inline CLI command, single line', () => {
    const msg = buildContextLinkNote('codex', 'Builder', '/x/context.sh')
    expect(msg).toContain('sh "/x/context.sh"')
    expect(msg).toContain('Builder')
    expect(msg).not.toContain('\n')
  })
  it('every variant says the note is informational — no action now', () => {
    // The message is injected + submitted as a prompt, so an agent that reads it as a task
    // launches an unsolicited investigation (observed with gemini). It must self-defuse.
    for (const agent of [undefined, 'claude', 'codex', 'gemini']) {
      const msg = buildContextLinkNote(agent, 'Builder', '/x/context.sh')
      expect(msg, `agent=${agent}`).toMatch(/[Nn]o action/)
      expect(msg, `agent=${agent}`).not.toContain('\n')
    }
  })
})

describe('buildCanvasControlNote', () => {
  it('points claude at the skill and self-defuses', () => {
    const msg = buildCanvasControlNote('claude')
    expect(msg).toContain('manage-nodeterm-canvas')
    expect(msg).toContain('No action needed now')
    expect(msg).not.toContain('\n') // pty.sendText submits — a newline would split the prompt
  })
  it('points codex/gemini at their global instructions section', () => {
    const msg = buildCanvasControlNote('codex')
    expect(msg).toContain('manage-nodeterm-canvas')
    expect(msg).toContain('global agent instructions')
    expect(msg).not.toContain('\n')
  })
})

describe('shouldPushControlNote', () => {
  it('pushes once per session for a controllable agent', () => {
    expect(shouldPushControlNote({ sessionId: 's1', canControl: true })).toBe(true)
  })
  it('never re-pushes the same session', () => {
    expect(shouldPushControlNote({ sessionId: 's1', controlNoted: 's1', canControl: true })).toBe(false)
  })
  it('pushes again for a NEW session of the same node', () => {
    expect(shouldPushControlNote({ sessionId: 's2', controlNoted: 's1', canControl: true })).toBe(true)
  })
  it('skips non-controllable agents and unknown sessions', () => {
    expect(shouldPushControlNote({ sessionId: 's1', canControl: false })).toBe(false)
    expect(shouldPushControlNote({ canControl: true })).toBe(false)
  })
})

describe('buildBackgroundLinkMaps', () => {
  const node = (over: Partial<CanvasNodeState>): CanvasNodeState =>
    ({
      id: 'x',
      kind: 'terminal',
      position: { x: 0, y: 0 },
      size: { width: 1, height: 1 },
      title: '',
      color: '',
      group: null,
      ...over
    }) as CanvasNodeState
  const projects = [
    {
      id: 'p-active',
      nodes: [node({ id: 'a1', agentId: 'claude' }), node({ id: 'a2', agentId: 'codex' })],
      bridges: [{ id: 'e0', source: 'a1', target: 'a2' }]
    },
    {
      id: 'p-bg',
      nodes: [
        node({ id: 'b1', title: 'Fitness', cwd: '/fit', agentId: 'claude', accountId: 'acct-1' }),
        node({ id: 'b2', title: 'Gem', cwd: '/fit', agentId: 'gemini' }),
        node({ id: 'b3', kind: 'sticky', title: 'Note', text: 'remember this' })
      ],
      bridges: [
        { id: 'e1', source: 'b1', target: 'b2' },
        { id: 'e2', source: 'b3', target: 'b1' }
      ]
    },
    { id: 'p-nolinks', nodes: [node({ id: 'c1' })], bridges: [] }
  ]

  it('maps every project except the active one (React Flow owns that live)', () => {
    const map = buildBackgroundLinkMaps(projects, 'p-active', () => undefined)
    expect(map['a1']).toBeUndefined()
    expect(map['a2']).toBeUndefined()
    expect(map['b1']).toBeDefined()
    expect(map['b2']).toEqual([
      { id: 'b1', title: 'Fitness', cwd: '/fit', agentId: 'claude', accountId: 'acct-1' }
    ])
  })
  it('serialized stickies map one-way with their text', () => {
    const map = buildBackgroundLinkMaps(projects, 'p-active', () => undefined)
    expect(map['b1']).toContainEqual({ id: 'b3', title: 'Note', note: 'remember this' })
    expect(map['b3']).toBeUndefined()
  })
  it('threads sessionIds from the callback', () => {
    const map = buildBackgroundLinkMaps(projects, 'p-active', (id) =>
      id === 'b2' ? 'sess-b2' : undefined
    )
    expect(map['b1']).toContainEqual({
      id: 'b2',
      title: 'Gem',
      cwd: '/fit',
      agentId: 'gemini',
      sessionId: 'sess-b2'
    })
  })
  it('drops edges whose endpoints are gone from the serialized nodes', () => {
    const map = buildBackgroundLinkMaps(
      [{ id: 'p', nodes: [node({ id: 'z1' })], bridges: [{ id: 'e', source: 'z1', target: 'gone' }] }],
      null,
      () => undefined
    )
    expect(map).toEqual({})
  })
})

describe('buildNotePushMessage per-agent wording', () => {
  it('keeps the skill pointer for claude and omitted agent', () => {
    expect(buildNotePushMessage('T', 'x'.repeat(3000), 'claude')).toContain('get-linked-context skill')
    expect(buildNotePushMessage('T', 'x'.repeat(3000))).toContain('get-linked-context skill')
  })
  it('points non-claude agents at the CLI instructions', () => {
    const msg = buildNotePushMessage('T', 'x'.repeat(3000), 'codex')!
    expect(msg).toContain('[truncated')
    expect(msg).not.toContain('skill]')
  })
})
