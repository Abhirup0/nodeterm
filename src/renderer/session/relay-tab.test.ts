import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  openRelayTab,
  handleRelayDrop,
  reconnectRelayTab,
  tabClickAction,
  type RelayTabDeps,
  type RelayReconnectDeps,
} from './relay-tab'
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

/** A bridged relay api whose `pty.create` is a spy — this is what `LocalTransport(api)` must hit.
 *  `presenceUnsub` is what the session's held presence teardown calls (onSync's unsubscribe), so a
 *  drop that "runs the presence teardown" is observable in node env. */
function fakeBridgedApi() {
  const ptyCreate = vi.fn().mockResolvedValue({ sessionId: 's1', fresh: false })
  const presenceUnsub = vi.fn()
  const api = {
    marker: 'relay-bridged',
    pty: { create: ptyCreate },
    presence: {
      hello: vi.fn().mockResolvedValue({ clientId: 'x', peers: [] }),
      onSync: vi.fn(() => presenceUnsub),
      onPeer: vi.fn(() => () => {}),
    },
  } as unknown as NodeTerminalApi
  return { api, ptyCreate, presenceUnsub }
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

describe('handleRelayDrop (Stage 4 Task 7 — involuntary drop → greyed reconnectable tab)', () => {
  it('marks the bound project unavailable + runs the presence teardown ONCE, never removes it', async () => {
    const { api, presenceUnsub } = fakeBridgedApi()
    const close = vi.fn()
    const handle: RelayApiHandle = { api, ready: () => Promise.resolve(), close }
    const { deps } = makeDeps({ handle })
    const tab = await openRelayTab('conn-1', "Ayşe's Mac", deps)

    const setProjectUnavailable = vi.fn()
    handleRelayDrop(tab, { setProjectUnavailable })

    // The tab greys but survives — the peer left every facepile (presence teardown ran) and the
    // dead socket was closed, but the PROJECT is kept and stays bound to a 'relay' source.
    expect(setProjectUnavailable).toHaveBeenCalledWith(tab.projectId, true)
    expect(presenceUnsub).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(sessionForProject(tab.projectId).source).toBe('relay') // still reconnectable in place
    expect(sessionForProject(tab.projectId).status).toBe('offline')
    expect(sessionCount()).toBe(2) // local + the offline relay — NOT removed

    // Idempotent: a redundant drop (a revoke racing the FIN) re-runs no teardown.
    handleRelayDrop(tab, { setProjectUnavailable })
    expect(presenceUnsub).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('reconnectRelayTab (Stage 4 Task 7 — reconnect an offline tab IN PLACE)', () => {
  function reconnectDeps(over: Partial<RelayReconnectDeps> = {}): {
    deps: RelayReconnectDeps
    connect: ReturnType<typeof vi.fn>
    mount: ReturnType<typeof vi.fn>
  } {
    const connect = vi.fn().mockResolvedValue('conn-new')
    const mount = vi.fn()
    const deps: RelayReconnectDeps = {
      promptForOffer: over.promptForOffer ?? (() => Promise.resolve('fresh-offer')),
      connect: over.connect ?? connect,
      mount: over.mount ?? mount,
      onError: over.onError ?? vi.fn(),
    }
    return { deps, connect, mount }
  }

  it('prompts for a FRESH code (the offer is single-use), connects, and mounts onto the SAME project', async () => {
    const { deps, connect, mount } = reconnectDeps()
    await reconnectRelayTab('proj-1', deps)
    expect(connect).toHaveBeenCalledWith('fresh-offer') // a fresh pairing, not a silent reuse
    expect(mount).toHaveBeenCalledWith('conn-new', 'proj-1') // reuse the existing tab, not a new one
  })

  it('connects BEFORE anything tears the stale session down (a connect failure must not strand the tab)', async () => {
    // The stale offline session is disposed by `mount`, only after the fresh session rebinds — never
    // up-front — so a connect that throws leaves the tab still bound + reconnectable. Assert mount is
    // the ONLY disposal lever and it never runs when connect fails.
    const onError = vi.fn()
    const mount = vi.fn()
    const { deps } = reconnectDeps({
      connect: vi.fn().mockRejectedValue(new Error('relay unreachable')),
      mount,
      onError,
    })
    await reconnectRelayTab('proj-1', deps)
    expect(mount).not.toHaveBeenCalled() // nothing disposed the stale session → tab stays reconnectable
    expect(onError).toHaveBeenCalledWith('relay unreachable')
  })

  it('a cancelled prompt reconnects nothing', async () => {
    const { deps, connect, mount } = reconnectDeps({
      promptForOffer: () => Promise.resolve(null),
    })
    await reconnectRelayTab('proj-1', deps)
    expect(connect).not.toHaveBeenCalled()
    expect(mount).not.toHaveBeenCalled()
  })

  it('surfaces a connect failure through onError (no throw)', async () => {
    const onError = vi.fn()
    const { deps } = reconnectDeps({
      connect: vi.fn().mockRejectedValue(new Error('relay unreachable')),
      onError,
    })
    await expect(reconnectRelayTab('proj-1', deps)).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith('relay unreachable')
  })
})

describe('tabClickAction (which behavior a tab click gets)', () => {
  it('an available tab switches', () => {
    expect(tabClickAction(false, 'relay')).toBe('switch')
    expect(tabClickAction(false, 'local')).toBe('switch')
  })
  it('an unavailable RELAY tab reconnects (a socket drop, clickable to reconnect)', () => {
    expect(tabClickAction(true, 'relay')).toBe('reconnect')
    expect(tabClickAction(true, 'server')).toBe('reconnect')
  })
  it('an unavailable LOCAL tab is inert (a missing folder, not clickable-to-reconnect)', () => {
    expect(tabClickAction(true, 'local')).toBe('ignore')
  })
})
