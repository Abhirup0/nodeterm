import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RemoteTransport } from './remote-transport'

// Minimal `window.nodeTerminal.remoteClient` fake: RemoteTransport is pure glue over it.
function fakeClient(history = 'HOST HISTORY') {
  return {
    create: vi.fn(async () => '7'),
    captureHistory: vi.fn(async () => history),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {})
  }
}

let client: ReturnType<typeof fakeClient>

beforeEach(() => {
  client = fakeClient()
  ;(globalThis as { window?: unknown }).window = { nodeTerminal: { remoteClient: client } }
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('RemoteTransport.captureHistory', () => {
  it('fetches the HOST-side scrollback for the session it attached for this node', async () => {
    // The client machine has no `nt-<nodeId>` tmux session, so hydration must go over the relay —
    // keyed by the stream the host granted this client, not by the tmux session name.
    const transport = new RemoteTransport('conn-1')
    await transport.create({ cols: 80, rows: 24, persistKey: 'node-a' })

    await expect(transport.captureHistory('node-a')).resolves.toBe('HOST HISTORY')
    expect(client.captureHistory).toHaveBeenCalledWith('conn-1', '7')
  })

  it('returns an empty history for a node it never attached (nothing to hydrate from)', async () => {
    const transport = new RemoteTransport('conn-1')
    await expect(transport.captureHistory('node-b')).resolves.toBe('')
    expect(client.captureHistory).not.toHaveBeenCalled()
  })

  it('reports a warm (non-fresh) attach, so TerminalNode takes the history-hydration path', async () => {
    const transport = new RemoteTransport('conn-1')
    await expect(transport.create({ cols: 80, rows: 24, persistKey: 'node-a' })).resolves.toEqual({
      sessionId: '7',
      fresh: false
    })
  })
})
