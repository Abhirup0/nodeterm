import { describe, it, expect } from 'vitest'
import { DownloadTickets } from './download-tickets'

describe('DownloadTickets', () => {
  it('redeems a ticket exactly once', () => {
    const t = new DownloadTickets()
    const token = t.issue('/srv/app/notes.md', false)
    expect(t.redeem(token)).toMatchObject({ path: '/srv/app/notes.md', dir: false })
    expect(t.redeem(token)).toBeNull()
  })

  it('refuses an expired ticket (and does not leak it back on a later call)', () => {
    let now = 1_000
    const t = new DownloadTickets({ ttlMs: 100, now: () => now })
    const token = t.issue('/srv/app/big.zip', false)
    now = 1_101
    expect(t.redeem(token)).toBeNull()
    now = 1_050
    expect(t.redeem(token)).toBeNull()
  })

  it('refuses an unknown token', () => {
    expect(new DownloadTickets().redeem('nope')).toBeNull()
  })

  it('mints unguessable, distinct tokens', () => {
    const t = new DownloadTickets()
    const tokens = new Set(Array.from({ length: 50 }, () => t.issue('/x', false)))
    expect(tokens.size).toBe(50)
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(30)
  })

  it('carries the directory flag through', () => {
    const t = new DownloadTickets()
    expect(t.redeem(t.issue('/srv/app/docs', true))).toMatchObject({ dir: true })
  })

  it('evicts under the cap without dropping a freshly minted ticket', () => {
    const t = new DownloadTickets()
    for (let i = 0; i < 300; i++) t.issue(`/x/${i}`, false)
    const fresh = t.issue('/x/fresh', false)
    expect(t.redeem(fresh)).toMatchObject({ path: '/x/fresh' })
  })
})
