import { describe, it, expect } from 'vitest'
import { buildLinkMap, buildNotePushMessage, classifyLink } from './noteLink'

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
