import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

// The store binds localStorage at import time, so each test stubs a fresh in-memory
// storage and re-imports the module (vi.resetModules) to exercise load()/save().
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

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

describe('loop persistence (cron/schedule survive an app restart)', () => {
  it('persists an active loop to localStorage and drops it on setLoop(false)', async () => {
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setLoop('n1', true, 'cron', { schedule: '0 9 * * *', task: 'daily report' })
    let saved = JSON.parse(store.getItem('nodeterm.agentStatus')!)
    expect(saved.n1.loop).toMatchObject({ kind: 'cron', schedule: '0 9 * * *', task: 'daily report' })
    useAgentStatus.getState().setLoop('n1', false)
    saved = JSON.parse(store.getItem('nodeterm.agentStatus') ?? '{}')
    expect(saved.n1?.loop).toBeUndefined()
  })

  it('restores a persisted cron loop on load', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({
        'nodeterm.agentStatus': JSON.stringify({
          n2: { unread: false, loop: { count: 3, kind: 'cron', schedule: '*/5 * * * *', task: 't', items: [] } }
        })
      })
    )
    const { useAgentStatus } = await import('./agentStatus')
    expect(useAgentStatus.getState().byId['n2']?.loop).toMatchObject({
      kind: 'cron',
      schedule: '*/5 * * * *'
    })
  })

  it('round-trips controlNoted (canvas-control discovery, once per session)', async () => {
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const { useAgentStatus } = await import('./agentStatus')
    useAgentStatus.getState().setControlNoted('n4', 'sess-1')
    const saved = JSON.parse(store.getItem('nodeterm.agentStatus')!)
    expect(saved.n4.controlNoted).toBe('sess-1')
    // A fresh module load restores it, so a restart never re-pushes the note.
    vi.resetModules()
    const reloaded = await import('./agentStatus')
    expect(reloaded.useAgentStatus.getState().byId['n4']?.controlNoted).toBe('sess-1')
  })

  it('tolerates a persisted entry without loop (older format)', async () => {
    vi.stubGlobal(
      'localStorage',
      memStorage({ 'nodeterm.agentStatus': JSON.stringify({ n3: { unread: true, sessionId: 's' } }) })
    )
    const { useAgentStatus } = await import('./agentStatus')
    expect(useAgentStatus.getState().byId['n3']).toMatchObject({ unread: true, sessionId: 's' })
    expect(useAgentStatus.getState().byId['n3'].loop).toBeUndefined()
  })
})
