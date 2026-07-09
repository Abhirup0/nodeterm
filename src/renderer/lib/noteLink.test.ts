import { describe, it, expect } from 'vitest'
import { buildContextLinkNote, buildLinkMap, buildNotePushMessage, classifyLink } from './noteLink'

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
  it('claude gets the skill wording (unchanged legacy text)', () => {
    expect(buildContextLinkNote('claude', 'Builder', '/x/context.sh')).toBe(
      '[nodeterm] You are now linked to "Builder". Use the get-linked-context skill to read its context when you need it.'
    )
  })
  it('codex/gemini get the inline CLI command, single line', () => {
    const msg = buildContextLinkNote('codex', 'Builder', '/x/context.sh')
    expect(msg).toContain('sh "/x/context.sh"')
    expect(msg).toContain('Builder')
    expect(msg).not.toContain('\n')
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
