import { describe, it, expect } from 'vitest'
import { applyStickyWrite, resolveStickyRef, STICKY_TEXT_MAX } from './stickyWrite'

const nodes = [
  { id: 'sticky-1', sticky: true, title: 'Linear: my tickets' },
  { id: 'sticky-2', sticky: true, title: 'Note' },
  { id: 'sticky-3', sticky: true, title: 'note' },
  { id: 'terminal-1', sticky: false, title: 'Build' }
]

describe('resolveStickyRef', () => {
  it('matches by exact id first', () => {
    expect(resolveStickyRef(nodes, 'sticky-1')).toEqual({ id: 'sticky-1' })
  })

  it('an id that names a non-sticky node is an error, never a title fallthrough', () => {
    const r = resolveStickyRef(nodes, 'terminal-1')
    expect(r).toEqual({ error: 'node terminal-1 is not a sticky note' })
  })

  it('matches by header title, case-insensitively, ignoring surrounding space', () => {
    expect(resolveStickyRef(nodes, 'linear: MY tickets')).toEqual({ id: 'sticky-1' })
    expect(resolveStickyRef(nodes, '  Linear: my tickets  ')).toEqual({ id: 'sticky-1' })
  })

  it('an ambiguous title lists the candidates and demands the id', () => {
    const r = resolveStickyRef(nodes, 'Note')
    expect(r).toMatchObject({ error: expect.stringContaining('sticky-2, sticky-3') })
  })

  it('a terminal sharing the title does not make a unique sticky ambiguous', () => {
    expect(resolveStickyRef(nodes, 'Build')).toEqual({ notFound: true })
  })

  it('no match is notFound (distinct from an error, for --create)', () => {
    expect(resolveStickyRef(nodes, 'nope')).toEqual({ notFound: true })
    expect(resolveStickyRef([], 'anything')).toEqual({ notFound: true })
  })

  it('an empty ref is an error', () => {
    expect(resolveStickyRef(nodes, '  ')).toEqual({ error: 'requires --node <id|title>' })
  })
})

describe('applyStickyWrite', () => {
  it('--text replaces, including with an empty string (clearing the note)', () => {
    expect(applyStickyWrite('old', { text: 'new' })).toEqual({ text: 'new', mode: 'replace' })
    expect(applyStickyWrite('old', { text: '' })).toEqual({ text: '', mode: 'replace' })
  })

  it('--append lands on its own line, without stacking trailing newlines', () => {
    expect(applyStickyWrite('a', { append: 'b' })).toEqual({ text: 'a\nb', mode: 'append' })
    expect(applyStickyWrite('a\n\n', { append: 'b' })).toEqual({ text: 'a\nb', mode: 'append' })
    expect(applyStickyWrite('', { append: 'b' })).toEqual({ text: 'b', mode: 'append' })
  })

  it('both flags at once is an error', () => {
    expect(applyStickyWrite('', { text: 'a', append: 'b' })).toEqual({
      error: 'pass either --text or --append, not both'
    })
  })

  it('neither flag is an error', () => {
    expect(applyStickyWrite('x', {})).toEqual({ error: 'requires --text or --append' })
  })

  it('refuses a body over the byte cap — measured in UTF-8 bytes, not chars', () => {
    const ok = applyStickyWrite('', { text: 'x'.repeat(STICKY_TEXT_MAX) })
    expect(ok).toMatchObject({ mode: 'replace' })
    const over = applyStickyWrite('x'.repeat(STICKY_TEXT_MAX), { append: 'y' })
    expect(over).toMatchObject({ error: expect.stringContaining('the cap is') })
    // 34_000 emoji are ~34k chars but >100k UTF-8 bytes.
    const multibyte = applyStickyWrite('', { text: '🙂'.repeat(34_000) })
    expect(multibyte).toMatchObject({ error: expect.stringContaining('bytes') })
  })
})
