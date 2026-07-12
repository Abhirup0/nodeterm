import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PRESENCE_COLORS, type PeerState } from '@shared/presence'

// The store reads localStorage at call time; each test stubs a fresh in-memory storage and
// re-imports the module (vi.resetModules) so nothing leaks between cases.
function memStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    }
  } as Storage
}

function peer(clientId: number, over: Partial<PeerState> = {}): PeerState {
  return {
    clientId,
    name: `P${clientId}`,
    color: PRESENCE_COLORS[0],
    cursor: null,
    focus: null,
    chat: null,
    typing: null,
    projectId: 'web',
    kind: 'browser',
    ...over
  }
}

/** A recording window.nodeTerminal.presence. */
function fakePresenceApi(hello = { clientId: 7, peers: [peer(7)] }) {
  const calls: Array<[string, unknown]> = []
  let syncCb: ((peers: PeerState[]) => void) | null = null
  let peerCb: ((diff: unknown) => void) | null = null
  const presence = {
    hello: vi.fn(async (id: unknown) => {
      calls.push(['hello', id])
      return hello
    }),
    cursor: (c: unknown) => calls.push(['cursor', c]),
    focus: (n: unknown) => calls.push(['focus', n]),
    chat: (t: unknown) => calls.push(['chat', t]),
    project: (p: unknown) => calls.push(['project', p]),
    onSync: (cb: (peers: PeerState[]) => void) => {
      syncCb = cb
      return () => (syncCb = null)
    },
    onPeer: (cb: (diff: unknown) => void) => {
      peerCb = cb
      return () => (peerCb = null)
    }
  }
  vi.stubGlobal('window', { nodeTerminal: { presence } })
  return {
    calls,
    presence,
    emitSync: (p: PeerState[]) => syncCb?.(p),
    emitPeer: (d: unknown) => peerCb?.(d)
  }
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('identity (the only persisted part of presence)', () => {
  it('round-trips {name,color} through localStorage under nodeterm.presence.me', async () => {
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { loadIdentity, saveIdentity, ME_KEY } = await import('./presence')
    expect(loadIdentity()).toBeNull()
    saveIdentity({ name: 'Enes', color: PRESENCE_COLORS[1] })
    expect(JSON.parse(store.getItem(ME_KEY)!)).toEqual({ name: 'Enes', color: PRESENCE_COLORS[1] })
    expect(loadIdentity()).toEqual({ name: 'Enes', color: PRESENCE_COLORS[1] })
  })

  it('survives corrupt storage (returns null instead of throwing)', async () => {
    vi.stubGlobal('localStorage', memStorage({ 'nodeterm.presence.me': '{not json' }))
    const { loadIdentity } = await import('./presence')
    expect(loadIdentity()).toBeNull()
  })
})

describe('connectPresence', () => {
  it('sends hello with the stored identity, records my id, and seeds the peer table', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.presence.me': JSON.stringify({ name: 'Enes', color: PRESENCE_COLORS[1] })
      })
    )
    const api = fakePresenceApi({ clientId: 7, peers: [peer(7, { name: 'Enes' }), peer(8)] })
    const { connectPresence, usePresence, selectOthers } = await import('./presence')

    const stop = connectPresence()
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))
    expect(api.calls[0]).toEqual(['hello', { name: 'Enes', color: PRESENCE_COLORS[1] }])
    expect(usePresence.getState().needsName).toBe(false)
    // My own peer is in the table but never in `others` — I must not draw my own cursor.
    expect(selectOthers(usePresence.getState()).map((p) => p.clientId)).toEqual([8])
    stop()
  })

  it('flags needsName (and does not say hello) when no identity is stored', async () => {
    vi.stubGlobal('localStorage', memStorage())
    const api = fakePresenceApi()
    const { connectPresence, usePresence } = await import('./presence')
    const stop = connectPresence()
    expect(usePresence.getState().needsName).toBe(true)
    expect(api.presence.hello).not.toHaveBeenCalled()
    stop()
  })

  it('setMe persists the identity, clears needsName and says hello', async () => {
    vi.stubGlobal('localStorage', memStorage())
    const api = fakePresenceApi()
    const { connectPresence, usePresence } = await import('./presence')
    const stop = connectPresence()
    usePresence.getState().setMe({ name: 'Ada', color: PRESENCE_COLORS[2] })
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))
    expect(usePresence.getState().needsName).toBe(false)
    expect(api.calls[0]).toEqual(['hello', { name: 'Ada', color: PRESENCE_COLORS[2] }])
    stop()
  })
})

describe('diff application', () => {
  it('applies join / update / leave and replaces the table on sync', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.presence.me': JSON.stringify({ name: 'Enes', color: PRESENCE_COLORS[1] })
      })
    )
    const api = fakePresenceApi({ clientId: 7, peers: [peer(7)] })
    const { connectPresence, usePresence, selectOthers, selectFocused } = await import('./presence')
    const stop = connectPresence()
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))

    api.emitPeer({ op: 'join', peer: peer(8, { name: 'Ada' }) })
    expect(selectOthers(usePresence.getState()).map((p) => p.name)).toEqual(['Ada'])

    api.emitPeer({ op: 'update', clientId: 8, patch: { cursor: { x: 4, y: 5 }, focus: 'node-a' } })
    expect(usePresence.getState().peers[8].cursor).toEqual({ x: 4, y: 5 })
    expect(selectFocused(usePresence.getState(), 'node-a', 'web').map((p) => p.clientId)).toEqual([
      8
    ])
    // An update for an unknown peer is ignored (no ghost rows).
    api.emitPeer({ op: 'update', clientId: 99, patch: { chat: 'boo' } })
    expect(usePresence.getState().peers[99]).toBeUndefined()

    api.emitPeer({ op: 'leave', clientId: 8 })
    expect(selectOthers(usePresence.getState())).toEqual([])

    api.emitSync([peer(7), peer(9)])
    expect(selectOthers(usePresence.getState()).map((p) => p.clientId)).toEqual([9])
    stop()
  })
})

describe('project scoping (a peer on another canvas is never drawn on mine)', () => {
  it('selectVisible / selectFocused honour the project; selectOthers (facepile) does not', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.presence.me': JSON.stringify({ name: 'Enes', color: PRESENCE_COLORS[1] })
      })
    )
    const api = fakePresenceApi({ clientId: 7, peers: [peer(7, { projectId: 'web' })] })
    const { connectPresence, usePresence, selectOthers, selectVisible, selectFocused } =
      await import('./presence')
    const stop = connectPresence()
    await vi.waitFor(() => expect(usePresence.getState().myId).toBe(7))

    api.emitPeer({ op: 'join', peer: peer(8, { projectId: 'web', focus: 'node-a' }) })
    api.emitPeer({ op: 'join', peer: peer(9, { projectId: 'api', focus: 'node-b' }) })
    api.emitPeer({ op: 'join', peer: peer(10, { projectId: null, kind: 'phone' }) })
    const s = usePresence.getState()

    // Canvas surfaces: only the peers on MY project.
    expect(selectVisible(s, 'web').map((p) => p.clientId)).toEqual([8])
    expect(selectFocused(s, 'node-a', 'web').map((p) => p.clientId)).toEqual([8])
    // A peer focused on a node of ANOTHER project must not chip a node here (ids are global).
    expect(selectFocused(s, 'node-b', 'web')).toEqual([])
    // No project open (welcome screen) → nothing is drawn at all.
    expect(selectVisible(s, null)).toEqual([])

    // The facepile shows everyone, whatever canvas they are on (including the cursorless phone).
    expect(selectOthers(s).map((p) => p.clientId)).toEqual([8, 9, 10])

    // Peer 8 switches to another project → their cursor leaves my canvas immediately.
    api.emitPeer({ op: 'update', clientId: 8, patch: { projectId: 'api' } })
    expect(selectVisible(usePresence.getState(), 'web')).toEqual([])
    stop()
  })
})

describe('reportFocus / reportProject', () => {
  it('send only on change (a terminal re-focusing the same node, or a tab switch back, must not spam the wire)', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.presence.me': JSON.stringify({ name: 'Enes', color: PRESENCE_COLORS[1] })
      })
    )
    const api = fakePresenceApi()
    const { reportFocus, reportProject } = await import('./presence')
    reportFocus('node-a')
    reportFocus('node-a')
    reportFocus(null)
    reportFocus(null)
    expect(api.calls.filter((c) => c[0] === 'focus')).toEqual([
      ['focus', 'node-a'],
      ['focus', null]
    ])

    reportProject('web')
    reportProject('web')
    reportProject('api')
    reportProject(null)
    expect(api.calls.filter((c) => c[0] === 'project')).toEqual([
      ['project', 'web'],
      ['project', 'api'],
      ['project', null]
    ])
  })
})
