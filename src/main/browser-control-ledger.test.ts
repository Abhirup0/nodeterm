import { describe, it, expect } from 'vitest'
import { BrowserControlLedger, type AgentBrowserEntry } from './browser-control-ledger'

function entry(over: Partial<AgentBrowserEntry> = {}): AgentBrowserEntry {
  return {
    ownerNodeId: 'claude-1',
    projectId: 'p-1',
    partition: 'persist:nt-agent-browser-p-1',
    navGeneration: 0,
    leaseActiveUntil: 0,
    openedAt: 1,
    ...over
  }
}

describe('BrowserControlLedger', () => {
  it('get() requires the SAME owner, and a stranger is indistinguishable from absent', () => {
    // Rule from S8's requireTab, adopted verbatim: the identical answer for "does not exist" and
    // "exists but is not yours". A different message is a node-enumeration oracle.
    const l = new BrowserControlLedger()
    l.claim('browser-3', entry({ ownerNodeId: 'claude-1' }))
    expect(l.get('browser-3', 'claude-2')).toBe(null)
    expect(l.get('browser-9', 'claude-2')).toBe(null)
  })

  it('get() returns the entry ONLY for the owner that opened it', () => {
    const l = new BrowserControlLedger()
    l.claim('browser-3', entry({ ownerNodeId: 'claude-1' }))
    expect(l.get('browser-3', 'claude-1')?.ownerNodeId).toBe('claude-1')
  })

  it('a second claim on a live id is refused — there is NO handoff, claim or transfer', () => {
    // S8 had claimUserTab. Dropped: an agent drives only what it itself opened, and there is no
    // verb by which the user's own browsing becomes an agent's. Deleting the feature also deletes
    // S8's child-session-invalidation-on-handoff case.
    const l = new BrowserControlLedger()
    expect(l.claim('browser-3', entry({ ownerNodeId: 'claude-1' }))).toBe(true)
    expect(l.claim('browser-3', entry({ ownerNodeId: 'claude-2' }))).toBe(false)
    // The original owner still owns it; the second claimant owns nothing.
    expect(l.get('browser-3', 'claude-1')?.ownerNodeId).toBe('claude-1')
    expect(l.get('browser-3', 'claude-2')).toBe(null)
  })

  it('claim refuses a blank browser id or a blank owner — there is no anonymous owner', () => {
    const l = new BrowserControlLedger()
    expect(l.claim('', entry())).toBe(false)
    expect(l.claim('browser-3', entry({ ownerNodeId: '' }))).toBe(false)
    expect(l.get('browser-3', '')).toBe(null)
  })

  it('claim refuses a blank projectId — a project-less entry is meaningless and would poison releaseByProject(\'\')', () => {
    // Belt to main's wiring guard: if a future open-browser reply ever drops the project id, no
    // ownership is recorded rather than an entry that releaseByProject('') would sweep.
    const l = new BrowserControlLedger()
    expect(l.claim('browser-3', entry({ projectId: '' }))).toBe(false)
    expect(l.get('browser-3', 'claude-1')).toBe(null)
    expect(l.releaseByProject('')).toEqual([])
  })

  it('release drops ownership — a released id is undrivable and re-claimable', () => {
    const l = new BrowserControlLedger()
    l.claim('browser-3', entry({ ownerNodeId: 'claude-1' }))
    l.release('browser-3')
    expect(l.get('browser-3', 'claude-1')).toBe(null)
    // Re-claimable by anyone now (its session ended); ownership is not sticky past release.
    expect(l.claim('browser-3', entry({ ownerNodeId: 'claude-2' }))).toBe(true)
  })

  it('releaseByOwner / releaseByProject / releaseAll return what they released, for detach', () => {
    const l = new BrowserControlLedger()
    l.claim('b-1', entry({ ownerNodeId: 'claude-1', projectId: 'p-1' }))
    l.claim('b-2', entry({ ownerNodeId: 'claude-1', projectId: 'p-2' }))
    l.claim('b-3', entry({ ownerNodeId: 'claude-9', projectId: 'p-2' }))

    expect(l.releaseByOwner('claude-1').sort()).toEqual(['b-1', 'b-2'])
    // b-1/b-2 gone, b-3 remains.
    expect(l.get('b-1', 'claude-1')).toBe(null)
    expect(l.get('b-3', 'claude-9')?.projectId).toBe('p-2')

    expect(l.releaseByProject('p-2')).toEqual(['b-3'])
    expect(l.get('b-3', 'claude-9')).toBe(null)

    l.claim('b-4', entry({ ownerNodeId: 'claude-1' }))
    expect(l.releaseAll()).toEqual(['b-4'])
    expect(l.releaseAll()).toEqual([])
  })

  it('activeLeases reports only nodes whose lease is live at now, with their owner', () => {
    const l = new BrowserControlLedger()
    l.claim('b-live', entry({ ownerNodeId: 'claude-1', leaseActiveUntil: 0 }))
    l.claim('b-dead', entry({ ownerNodeId: 'claude-2', leaseActiveUntil: 0 }))
    l.touchLease('b-live', 1000)
    l.touchLease('b-missing', 5000) // no-op: unclaimed
    expect(l.activeLeases(500)).toEqual([{ browserNodeId: 'b-live', ownerNodeId: 'claude-1' }])
    // Exactly AT the deadline the lease has lapsed — `until > now`, not `>=` (a lease is live up to
    // but not including its expiry, or a stale lease leaks one tick past its end).
    expect(l.activeLeases(1000)).toEqual([])
    // And well after.
    expect(l.activeLeases(2000)).toEqual([])
  })

  it('nothing is persisted: a fresh ledger owns nothing', () => {
    // Ownership does not survive a restart, by design. See the ropes test in Task 4.4 for why.
    expect(new BrowserControlLedger().get('browser-3', 'claude-1')).toBe(null)
  })

  it('claim stores a COPY — mutating the caller\'s entry afterwards cannot rewrite ownership', () => {
    // The owner arriving by reference would let a later caller flip ownerNodeId post-claim.
    const l = new BrowserControlLedger()
    const e = entry({ ownerNodeId: 'claude-1' })
    l.claim('browser-3', e)
    e.ownerNodeId = 'claude-evil'
    expect(l.get('browser-3', 'claude-1')?.ownerNodeId).toBe('claude-1')
    expect(l.get('browser-3', 'claude-evil')).toBe(null)
  })
})
