import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const systemIdentity = vi.fn()

/** Fresh store per test — the once-guard is module state, so we re-import after resetModules. */
async function freshStore() {
  vi.resetModules()
  vi.stubGlobal('window', {
    nodeTerminal: { codexAccounts: { systemIdentity } }
  })
  return (await import('./systemCodexAccount')).useSystemCodexAccount
}

beforeEach(() => {
  systemIdentity.mockReset()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useSystemCodexAccount.ensure', () => {
  it('reads the local system identity exactly once per session', async () => {
    systemIdentity.mockResolvedValue({ email: 'me@mac' })
    const store = await freshStore()
    store.getState().ensure()
    store.getState().ensure()
    await vi.waitFor(() => expect(store.getState().email).toBe('me@mac'))
    // Once-guard: the second ensure() must not fire a second read.
    expect(systemIdentity).toHaveBeenCalledTimes(1)
    expect(systemIdentity).toHaveBeenCalledWith()
  })

  it('fails closed to null when the read rejects (no fabrication)', async () => {
    systemIdentity.mockRejectedValue(new Error('no login'))
    const store = await freshStore()
    store.getState().ensure()
    await vi.waitFor(() => expect(store.getState().loaded).toBe(true))
    expect(store.getState().email).toBeNull()
  })
})

describe('useSystemCodexAccount.ensureRemote', () => {
  it('probes each host once and asks with that host connection', async () => {
    systemIdentity.mockResolvedValue({ email: 'me@box' })
    const store = await freshStore()
    store.getState().ensureRemote('u@box', 'proj-1')
    store.getState().ensureRemote('u@box', 'proj-1') // in-flight guard
    await vi.waitFor(() => expect(store.getState().remoteEmails['u@box']).toBe('me@box'))
    store.getState().ensureRemote('u@box', 'proj-1') // already-resolved guard
    expect(systemIdentity).toHaveBeenCalledTimes(1)
    expect(systemIdentity).toHaveBeenCalledWith({ projectId: 'proj-1' })
  })

  it('records a resolved-but-null host and never re-probes it', async () => {
    systemIdentity.mockResolvedValue({ email: null })
    const store = await freshStore()
    store.getState().ensureRemote('u@box', 'proj-1')
    await vi.waitFor(() => expect(Object.hasOwn(store.getState().remoteEmails, 'u@box')).toBe(true))
    expect(store.getState().remoteEmails['u@box']).toBeNull()
    store.getState().ensureRemote('u@box', 'proj-1')
    expect(systemIdentity).toHaveBeenCalledTimes(1)
  })

  it('keeps different hosts in separate slots', async () => {
    systemIdentity.mockImplementation(async (ctx: { projectId: string }) =>
      ctx.projectId === 'p-a' ? { email: 'a@box' } : { email: 'b@box' }
    )
    const store = await freshStore()
    store.getState().ensureRemote('a@box', 'p-a')
    store.getState().ensureRemote('b@box', 'p-b')
    await vi.waitFor(() => {
      expect(store.getState().remoteEmails['a@box']).toBe('a@box')
      expect(store.getState().remoteEmails['b@box']).toBe('b@box')
    })
    expect(systemIdentity).toHaveBeenCalledTimes(2)
  })
})
