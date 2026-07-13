import { describe, it, expect, beforeEach } from 'vitest'
import {
  createSession,
  getSessionStores,
  getActiveSession,
  setActiveSession,
  activeSessionApi,
  resetSessionsForTest,
} from './session'
import type { NodeTerminalApi } from '@shared/types'

// A distinctive object we can assert is preserved BY IDENTITY (the behavior-unchanged guarantee).
const fakeApi = { marker: 'preload' } as unknown as NodeTerminalApi

beforeEach(() => {
  resetSessionsForTest()
})

describe('createSession', () => {
  it('returns the pinned 5-field shape and preserves the api object by identity', () => {
    const s = createSession('local', fakeApi, 'This Mac')
    expect(s).toMatchObject({ source: 'local', label: 'This Mac', status: 'connected' })
    expect(typeof s.id).toBe('string')
    expect(s.api).toBe(fakeApi) // identity, not a copy — this is the whole guarantee
  })

  it('gives the local session the fixed id "local"', () => {
    expect(createSession('local', fakeApi, 'This Mac').id).toBe('local')
  })

  it('registers per-session stores addressable by id', () => {
    const s = createSession('local', fakeApi, 'This Mac')
    const stores = getSessionStores(s.id)
    expect(stores.presence).toBeDefined()
    expect(stores.agentStatus).toBeDefined()
  })

  it('is idempotent per id: a duplicate createSession returns the existing session and does NOT rebuild its stores', () => {
    // After Task 2 buildStores() constructs a REAL presence store with a live subscription.
    // A second createSession('local', …) (hot reload, a test helper, a reconnect path) must
    // NOT build a second store — that would violate Stage 1's "exactly one subscriber" invariant.
    const first = createSession('local', fakeApi, 'This Mac')
    const storesBefore = getSessionStores(first.id)
    const again = createSession('local', { other: true } as unknown as NodeTerminalApi, 'Renamed')
    expect(again).toBe(first) // the existing session object, by identity
    expect(again.api).toBe(fakeApi) // the first registration wins — nothing was overwritten
    expect(getSessionStores(first.id)).toBe(storesBefore) // stores were not rebuilt
    expect(getSessionStores(first.id).presence).toBe(storesBefore.presence)
  })

  it('gives distinct remote sessions distinct ids and distinct store objects', () => {
    // The property Tasks 2/4 and 4c depend on: per-session stores are never shared.
    const relay = createSession('relay', fakeApi, "Ayşe's Mac")
    const server = createSession('server', fakeApi, 'prod-box')
    expect(relay.id).not.toBe(server.id)
    const relayStores = getSessionStores(relay.id)
    const serverStores = getSessionStores(server.id)
    expect(relayStores).not.toBe(serverStores)
    expect(relayStores.presence).not.toBe(serverStores.presence)
    expect(relayStores.agentStatus).not.toBe(serverStores.agentStatus)
  })

  it('tracks the active session and exposes its api to non-components', () => {
    const s = createSession('local', fakeApi, 'This Mac')
    setActiveSession(s.id)
    expect(getActiveSession()).toBe(s)
    expect(activeSessionApi()).toBe(fakeApi)
  })

  it('throws for an unknown session id', () => {
    expect(() => getSessionStores('nope')).toThrow()
  })
})
