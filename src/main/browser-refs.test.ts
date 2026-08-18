import { describe, it, expect } from 'vitest'
import { RefTable, refStaleMessage } from './browser-refs'

const items = () => [
  { ref: 0, tag: 'A', text: 'Home' },
  { ref: 1, tag: 'BUTTON', text: 'Delete account' },
  { ref: 2, tag: 'A', text: 'Next page' }
]

describe('RefTable — @refs are scoped to a node AND a navigation generation', () => {
  it('--read map mints @1…@n bound to (nodeId, gen)', () => {
    const t = new RefTable()
    const { gen, labels } = t.mint('browser-1', 0, items())
    expect(gen).toBe(0)
    expect(labels).toEqual(['@1', '@2', '@3'])
    const r = t.resolve('browser-1', 0, '@2')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.item).toMatchObject({ tag: 'BUTTON', text: 'Delete account' })
  })

  it('a stale ref is a REFUSAL, not a re-resolution — this is a correctness property first', () => {
    // A stale ref that silently re-resolves is how an agent clicks "Delete account" while meaning
    // "Next page".
    const t = new RefTable()
    t.mint('browser-1', 0, items())
    // Page.frameNavigated bumps the generation and invalidates EVERY ref.
    t.bumpGeneration('browser-1')
    const r = t.resolve('browser-1', 0, '@2')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.stale).toBe(true)
      // It is the design's exact sentence, and it never carries a re-resolved item.
      expect(r.message).toBe(
        '@2 is not on the current page (the page navigated since the last --read map; re-read it)'
      )
      expect(r).not.toHaveProperty('item')
    }
  })

  it('Runtime.executionContextsCleared bumps the generation too (same single invalidation path)', () => {
    const t = new RefTable()
    t.mint('browser-1', 0, items())
    // Both Page.frameNavigated and Runtime.executionContextsCleared are wired to bumpGeneration.
    t.bumpGeneration('browser-1')
    t.bumpGeneration('browser-1')
    expect(t.currentGeneration('browser-1')).toBe(2)
    expect(t.resolve('browser-1', 0, '@1').ok).toBe(false)
  })

  it('a bump DROPS the old items, so a ref does not resolve even at the NEW generation', () => {
    // Without clearing, an agent that already knows the new gen could resolve a handle that
    // described the page BEFORE it navigated — the exact "@ref is silently stale" bug.
    const t = new RefTable()
    t.mint('browser-1', 0, items())
    t.bumpGeneration('browser-1') // now on gen 1, no fresh map read yet
    const r = t.resolve('browser-1', 1, '@1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).not.toContain('Delete account')
  })

  it('after a fresh --read map at the new generation, its refs resolve again', () => {
    const t = new RefTable()
    t.mint('browser-1', 0, items())
    t.bumpGeneration('browser-1') // now on gen 1
    t.mint('browser-1', 1, items()) // re-read map at gen 1
    expect(t.resolve('browser-1', 1, '@3').ok).toBe(true)
    // The old-generation ref is still refused.
    expect(t.resolve('browser-1', 0, '@3').ok).toBe(false)
  })

  it('the exact stale sentence is exported and reusable', () => {
    expect(refStaleMessage('@7')).toBe(
      '@7 is not on the current page (the page navigated since the last --read map; re-read it)'
    )
  })

  it('a ref from ANOTHER node never resolves', () => {
    const t = new RefTable()
    t.mint('browser-1', 0, items())
    expect(t.resolve('browser-2', 0, '@1').ok).toBe(false)
  })

  it('a label that was never minted at the current generation is refused (not a guess)', () => {
    const t = new RefTable()
    t.mint('browser-1', 0, items())
    const r = t.resolve('browser-1', 0, '@99')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.stale).toBe(false) // present generation, but no such ref — not a nav-stale
  })
})

describe('RefTable.spend — how PR 8 verbs (--click/--type/--wait) redeem a ref', () => {
  it('spends a live ref against the generation its map was minted on', () => {
    const t = new RefTable()
    t.mint('browser-1', 0, items())
    const r = t.spend('browser-1', '@2')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.item).toMatchObject({ tag: 'BUTTON', text: 'Delete account' })
  })

  it('a ref spent AFTER a navigation is STALE — never re-resolved against a newer map (PR 5)', () => {
    // This is the property a --click must uphold: clicking @2 ("Delete account") after the page
    // navigated must be refused, not silently re-resolved to whatever is @2 on the new page.
    const t = new RefTable()
    t.mint('browser-1', 0, items())
    t.bumpGeneration('browser-1') // Page.frameNavigated
    const r = t.spend('browser-1', '@2')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.stale).toBe(true)
      expect(r.message).toBe(
        '@2 is not on the current page (the page navigated since the last --read map; re-read it)'
      )
      expect(r).not.toHaveProperty('item')
    }
  })

  it('a fresh map after the navigation makes its refs spendable again', () => {
    const t = new RefTable()
    t.mint('browser-1', 0, items())
    t.bumpGeneration('browser-1')
    t.mint('browser-1', 1, items()) // --read map at the new generation
    expect(t.spend('browser-1', '@2').ok).toBe(true)
  })

  it('a ref from ANOTHER node is refused, and a node that never read a map has nothing to spend', () => {
    const t = new RefTable()
    t.mint('browser-1', 0, items())
    expect(t.spend('browser-2', '@1').ok).toBe(false)
    expect(t.spend('never-read', '@1').ok).toBe(false)
  })

  it('an out-of-range label on the current page is a refusal, not a guess', () => {
    const t = new RefTable()
    t.mint('browser-1', 0, items())
    const r = t.spend('browser-1', '@99')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.stale).toBe(false) // present, unknown — not nav-stale
  })
})
