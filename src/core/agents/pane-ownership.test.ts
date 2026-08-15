import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordFreshSpawnOwner,
  paneOwnerProject,
  forgetPaneOwner,
  resetPaneOwnershipForTests
} from './pane-ownership'

beforeEach(() => resetPaneOwnershipForTests())

describe('pane-ownership ledger', () => {
  it('records and returns the project that freshly spawned a node', () => {
    recordFreshSpawnOwner('n1', 'proj-a')
    expect(paneOwnerProject('n1')).toBe('proj-a')
  })

  it('an unrecorded node is UNPROVEN (undefined) — the fail-closed default after a restart', () => {
    // The whole cold-state contract: nothing recorded ⇒ the delivery gate must refuse. This is the
    // state every node is in immediately after an app restart (re-attach records nothing).
    expect(paneOwnerProject('never-spawned')).toBeUndefined()
  })

  it('a genuine respawn OVERWRITES — the live pane is the one that just came into being', () => {
    recordFreshSpawnOwner('n1', 'proj-a')
    recordFreshSpawnOwner('n1', 'proj-b')
    expect(paneOwnerProject('n1')).toBe('proj-b')
  })

  it('a missing owner is a no-op — an old caller passing none leaves the pane unproven, not owned', () => {
    recordFreshSpawnOwner('n1', undefined)
    expect(paneOwnerProject('n1')).toBeUndefined()
    recordFreshSpawnOwner('', 'proj-a')
    expect(paneOwnerProject('')).toBeUndefined()
  })

  it('forget drops ownership back to unproven — a deleted/recycled session is no longer owned', () => {
    recordFreshSpawnOwner('n1', 'proj-a')
    forgetPaneOwner('n1')
    expect(paneOwnerProject('n1')).toBeUndefined()
  })

  it('nodes are independent — forgetting one leaves the others', () => {
    recordFreshSpawnOwner('n1', 'proj-a')
    recordFreshSpawnOwner('n2', 'proj-a')
    forgetPaneOwner('n1')
    expect(paneOwnerProject('n1')).toBeUndefined()
    expect(paneOwnerProject('n2')).toBe('proj-a')
  })
})
