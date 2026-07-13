import { describe, it, expect } from 'vitest'
import { createSession, getSessionStores, getActiveSession, setActiveSession, activeSessionApi } from './session'
import type { NodeTerminalApi } from '@shared/types'

// A distinctive object we can assert is preserved BY IDENTITY (the behavior-unchanged guarantee).
const fakeApi = { marker: 'preload' } as unknown as NodeTerminalApi

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
