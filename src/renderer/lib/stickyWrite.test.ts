import { describe, it, expect } from 'vitest'
import { applyStickyWrite, parseStickyArgs, resolveStickyRef, STICKY_TEXT_MAX } from './stickyWrite'

const nodes = [
  { id: 'sticky-1', sticky: true, title: 'Linear: my tickets' },
  { id: 'sticky-2', sticky: true, title: 'Note' },
  { id: 'sticky-3', sticky: true, title: 'note' },
  { id: 'terminal-1', sticky: false, title: 'Build' }
]

describe('parseStickyArgs', () => {
  it('accepts the two write forms, ref trimmed', () => {
    expect(parseStickyArgs({ node: ' n1 ', text: '# md' })).toEqual({
      ref: 'n1',
      write: { text: '# md', append: undefined },
      create: false
    })
    expect(parseStickyArgs({ node: 'n1', append: 'line' })).toEqual({
      ref: 'n1',
      write: { text: undefined, append: 'line' },
      create: false
    })
  })

  it('requires --node and exactly one of --text/--append; empty --text is a legal clear', () => {
    expect(parseStickyArgs({ text: 'x' })).toEqual({ error: 'requires --node <id|title>' })
    expect(parseStickyArgs({ node: 'n1' })).toEqual({ error: 'requires --text or --append' })
    expect(parseStickyArgs({ node: 'n1', text: 'a', append: 'b' })).toEqual({
      error: 'pass either --text or --append, not both'
    })
    expect(parseStickyArgs({ node: 'n1', text: '' })).toMatchObject({ write: { text: '' } })
  })

  it('an unknown flag is refused — the tripwire for a body starting with --', () => {
    // `--text $'---\n# Build'` through the shim peek rule arrives as text='' plus a junk flag;
    // without this refusal that legitimate markdown body silently WIPES the note with an ok reply.
    const r = parseStickyArgs({ node: 'n1', text: '', '-\n# Build': '' })
    expect(r).toMatchObject({ error: expect.stringContaining('--text=<value>') })
  })

  it('--create takes a value: yes/true/1 create; anything else (incl. JSON false) does not', () => {
    for (const v of ['yes', 'YES', 'true', '1']) {
      expect(parseStickyArgs({ node: 'n1', text: 'x', create: v })).toMatchObject({ create: true })
    }
    for (const v of ['', 'no', 'false', '0', 'maybe']) {
      expect(parseStickyArgs({ node: 'n1', text: 'x', create: v })).toMatchObject({ create: false })
    }
    expect(parseStickyArgs({ node: 'n1', text: 'x' })).toMatchObject({ create: false })
  })
})

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

  it('normalizes control chars through oneLine on both sides, so a --create ref re-matches the note it created', () => {
    // Created notes are titled oneLine(ref) ('Sprint\t42' → 'Sprint 42'); the raw ref must land
    // on that note next run, or every run mints a duplicate and then locks out on ambiguity.
    const created = [{ id: 'sticky-9', sticky: true, title: 'Sprint 42' }]
    expect(resolveStickyRef(created, 'Sprint\t42')).toEqual({ id: 'sticky-9' })
    expect(resolveStickyRef(created, 'sprint 42')).toEqual({ id: 'sticky-9' })
  })

  it('an ambiguous title lists the candidates and demands the id', () => {
    const r = resolveStickyRef(nodes, 'Note')
    expect(r).toMatchObject({ error: expect.stringContaining('sticky-2, sticky-3') })
  })

  it('a terminal sharing the title does not make the ref ambiguous or found', () => {
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

  it('caps in JSON-serialized units, so escape-heavy bodies cannot slip past toward the sync ceiling', () => {
    const ok = applyStickyWrite('', { text: 'x'.repeat(STICKY_TEXT_MAX - 2) })
    expect(ok).toMatchObject({ mode: 'replace' })
    const over = applyStickyWrite('x'.repeat(STICKY_TEXT_MAX - 2), { append: 'yyy' })
    expect(over).toMatchObject({ error: expect.stringContaining('the cap is') })
    // 20k ESC control chars are 20k chars raw but ~120k once JSON-escaped (\u001b is 6 chars escaped).
    const escaped = applyStickyWrite('', { text: '\u001b'.repeat(20_000) })
    expect(escaped).toMatchObject({ error: expect.stringContaining('the cap is') })
  })
})
