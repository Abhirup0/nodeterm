import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openRelayTab, type RelayTabDeps } from './relay-tab'
import {
  createSession,
  setActiveSession,
  sessionForProject,
  sessionCount,
  resetSessionsForTest,
} from './session'
import { LocalTransport } from '../terminal/local-transport'
import type { NodeTerminalApi } from '@shared/types'
import type { RelayApiHandle } from '../bridge/relay-api'

/** A fake relayClient.onClosed sink: keeps the callback so the test can fire a socket drop. */
function fakeRelayClient() {
  const closeCbs: Array<() => void> = []
  const unsub = vi.fn()
  return {
    onClosed: vi.fn((_connectionId: string, cb: () => void) => {
      closeCbs.push(cb)
      return unsub
    }),
    unsub,
    fireClose: () => closeCbs.forEach((cb) => cb()),
  }
}

/** A bridged relay api whose `pty.create` is a spy — this is what `LocalTransport(api)` must hit. */
function fakeBridgedApi() {
  const ptyCreate = vi.fn().mockResolvedValue({ sessionId: 's1', fresh: false })
  const api = {
    marker: 'relay-bridged',
    pty: { create: ptyCreate },
    presence: {
      hello: vi.fn().mockResolvedValue({ clientId: 'x', peers: [] }),
      onSync: vi.fn(() => () => {}),
      onPeer: vi.fn(() => () => {}),
    },
  } as unknown as NodeTerminalApi
  return { api, ptyCreate }
}

function makeDeps(over: Partial<RelayTabDeps> & { handle: RelayApiHandle }): {
  deps: RelayTabDeps
  addProject: ReturnType<typeof vi.fn>
  setActiveProject: ReturnType<typeof vi.fn>
} {
  const addProject = vi.fn((_label: string) => ({ id: 'proj-1' }))
  const setActiveProject = vi.fn()
  const deps: RelayTabDeps = {
    relayClient: over.relayClient ?? fakeRelayClient(),
    addProject: over.addProject ?? addProject,
    setActiveProject: over.setActiveProject ?? setActiveProject,
    buildApi: () => over.handle,
    timeoutMs: over.timeoutMs,
  }
  return { deps, addProject, setActiveProject }
}

beforeEach(() => {
  resetSessionsForTest()
  // A local session must exist so a disposed remote tab resolves back to it (not a throw).
  const local = createSession('local', { marker: 'local' } as unknown as NodeTerminalApi, 'This Mac')
  setActiveSession(local.id)
})

describe('openRelayTab (connect → tab → mount)', () => {
  it('an approving connection becomes a relay session, a bound tab, and the active session', async () => {
    const { api, ptyCreate } = fakeBridgedApi()
    const close = vi.fn()
    const handle: RelayApiHandle = { api, ready: () => Promise.resolve(), close }
    const { deps, addProject, setActiveProject } = makeDeps({ handle })

    const tab = await openRelayTab('conn-1', "Ayşe's Mac", deps)

    // A relay session now exists and the tab is bound to it.
    const session = sessionForProject(tab.projectId)
    expect(session.source).toBe('relay')
    expect(session.id).toBe(tab.sessionId)
    expect(session.api).toBe(api)
    expect(addProject).toHaveBeenCalledWith("Ayşe's Mac")
    expect(setActiveProject).toHaveBeenCalledWith('proj-1')

    // The one-protocol payoff: a TerminalNode under this session builds LocalTransport(session.api),
    // and its pty work hits the BRIDGED (remote) pty — not the local preload.
    await new LocalTransport(session.api).create({ persistKey: tab.sessionId } as never)
    expect(ptyCreate).toHaveBeenCalledTimes(1)

    // dispose() tears the session down (relay socket close) exactly once and unbinds the tab.
    expect(close).not.toHaveBeenCalled()
    tab.dispose()
    expect(close).toHaveBeenCalledTimes(1)
    expect(sessionForProject(tab.projectId).source).toBe('local') // unbound → local
    expect(sessionCount()).toBe(1) // only local remains
  })

  it('GUARD: a pre-approval socket drop REJECTS the bootstrap (never hangs) and closes the handle', async () => {
    const { api } = fakeBridgedApi()
    const close = vi.fn()
    // ready() that resolves only on approval and NEVER rejects — the hang risk from frame-transport.
    const handle: RelayApiHandle = { api, ready: () => new Promise<void>(() => {}), close }
    const relayClient = fakeRelayClient()
    const { deps } = makeDeps({ handle, relayClient })

    const bootstrap = openRelayTab('conn-2', 'doomed', deps)
    // The socket dies BEFORE either human approves.
    relayClient.fireClose()

    await expect(bootstrap).rejects.toThrow(/clos/i)
    expect(close).toHaveBeenCalledTimes(1) // the dead relay socket is torn down
    expect(sessionCount()).toBe(1) // no relay session was ever registered — only local
  })

  it('GUARD: a timeout backstop rejects a ready() that neither approves nor closes', async () => {
    vi.useFakeTimers()
    try {
      const { api } = fakeBridgedApi()
      const close = vi.fn()
      const handle: RelayApiHandle = { api, ready: () => new Promise<void>(() => {}), close }
      const { deps } = makeDeps({ handle, timeoutMs: 50 })

      const bootstrap = openRelayTab('conn-3', 'stuck', deps)
      const assertion = expect(bootstrap).rejects.toThrow(/tim(e|ed)/i)
      await vi.advanceTimersByTimeAsync(60)
      await assertion
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
