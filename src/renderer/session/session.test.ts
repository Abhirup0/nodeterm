import { describe, it, expect, beforeEach } from 'vitest'
import {
  createSession,
  getSessionStores,
  getActiveSession,
  setActiveSession,
  activeSessionApi,
  sessionForProject,
  sessionCount,
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

  it('gives distinct remote sessions (distinct apis) distinct ids and distinct store objects', () => {
    // The property Tasks 2/4 and 4c depend on: stores for DIFFERENT cores are never shared.
    // Each session gets its own api object here — presence is keyed by api identity, so two
    // sessions on the same api deliberately share a presence store (see the adversarial test).
    const relayApi = { marker: 'relay' } as unknown as NodeTerminalApi
    const serverApi = { marker: 'server' } as unknown as NodeTerminalApi
    const relay = createSession('relay', relayApi, "Ayşe's Mac")
    const server = createSession('server', serverApi, 'prod-box')
    expect(relay.id).not.toBe(server.id)
    const relayStores = getSessionStores(relay.id)
    const serverStores = getSessionStores(server.id)
    expect(relayStores).not.toBe(serverStores)
    expect(relayStores.presence).not.toBe(serverStores.presence)
    expect(relayStores.agentStatus).not.toBe(serverStores.agentStatus)
  })

  it('ADVERSARIAL: a non-local session handed the local api shares the local presence store', () => {
    // The one-store-per-core guarantee must rest on api IDENTITY, not on the source string a
    // caller can get wrong. A relay/server session built against the SAME api (a loopback debug
    // session, a careless test double handing over window.nodeTerminal) must resolve to the
    // SAME presence store — a second store on the same bridge would subscribe second and miss
    // the pre-subscribe replay buffer (Stage 1: first subscriber only), silently diverging.
    const local = createSession('local', fakeApi, 'This Mac')
    const relay = createSession('relay', fakeApi, 'loopback')
    expect(relay.id).not.toBe(local.id) // still two sessions…
    expect(getSessionStores(relay.id).presence).toBe(getSessionStores(local.id).presence) // …ONE store
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

describe('sessionForProject (runtime tab → session resolver, never persisted)', () => {
  it('sessionForProject returns the active (local) session for any project today', () => {
    const s = createSession('local', fakeApi, 'This Mac')
    setActiveSession(s.id)
    expect(sessionForProject('any-project-id')).toBe(s)
    expect(sessionCount()).toBe(1)
  })

  it('sessionCount counts registered sessions', () => {
    expect(sessionCount()).toBe(0)
    createSession('local', fakeApi, 'This Mac')
    expect(sessionCount()).toBe(1)
    createSession('relay', { marker: 'relay' } as unknown as NodeTerminalApi, "Ayşe's Mac")
    expect(sessionCount()).toBe(2)
  })
})
