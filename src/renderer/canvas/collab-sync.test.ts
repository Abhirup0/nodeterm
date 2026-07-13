import { describe, it, expect, beforeEach } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import {
  createSession,
  setActiveSession,
  bindProjectToSession,
  sessionForProject,
  resetSessionsForTest,
} from '../session/session'
import { canvasSyncTarget } from './collab-sync'

const localApi = { marker: 'local' } as unknown as NodeTerminalApi
const relayApi = { marker: 'relay' } as unknown as NodeTerminalApi

describe('canvasSyncTarget (Task 4 — publisher/onMutation follow the ACTIVE session)', () => {
  beforeEach(() => resetSessionsForTest())

  it('relay tab: the mutate/subscribe target is the RELAY api, and the gate arms when the relay presence has a peer', () => {
    const local = createSession('local', localApi, 'This Mac')
    setActiveSession(local.id)
    const relay = createSession('relay', relayApi, "Ayşe's Mac")
    bindProjectToSession('remote-tab', relay.id)

    // The active tab is the relay one → publisher/onMutation must hit the RELAY core, not local.
    const active = sessionForProject('remote-tab')

    // A teammate is attached on the relay presence (peers includes me + Ayşe) → publish.
    const withPeer = canvasSyncTarget(active, { peers: { me: {}, ayse: {} } })
    expect(withPeer.api).toBe(relayApi)
    expect(withPeer.api).not.toBe(localApi)
    expect(withPeer.hasPeers).toBe(true)

    // Solo on the relay (only my own row) → no publish, but the target api is unchanged.
    const solo = canvasSyncTarget(active, { peers: { me: {} } })
    expect(solo.api).toBe(relayApi)
    expect(solo.hasPeers).toBe(false)
  })

  it('local tab: the target is window.nodeTerminal (the local api) — byte-identical to today', () => {
    const local = createSession('local', localApi, 'This Mac')
    setActiveSession(local.id)
    createSession('relay', relayApi, "Ayşe's Mac") // registered but not the active tab's binding

    const active = sessionForProject('some-local-tab') // unbound → resolves local
    expect(canvasSyncTarget(active, { peers: { me: {} } }).api).toBe(localApi)
    expect(canvasSyncTarget(active, { peers: { me: {}, other: {} } }).hasPeers).toBe(true)
  })

  it('empty peer table → no peers (nothing published on a fresh, still-connecting session)', () => {
    const local = createSession('local', localApi, 'This Mac')
    setActiveSession(local.id)
    expect(canvasSyncTarget(local, { peers: {} }).hasPeers).toBe(false)
  })
})
