import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RemoteTransport } from './remote-transport'

// Minimal `window.nodeTerminal.remoteClient` fake: RemoteTransport is pure glue over it.
function fakeClient() {
  return {
    create: vi.fn(async () => '7'),
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

describe('RemoteTransport.create', () => {
  it('reports a warm (non-fresh) attach: a mirroring client must never replay or relaunch', async () => {
    // Cold-restore (scrollback replay / agent resume) is the HOST's responsibility. Nothing is
    // hydrated on a warm attach — the host's tmux redraws the pane and owns its history.
    const transport = new RemoteTransport('conn-1')
    await expect(transport.create({ cols: 80, rows: 24, persistKey: 'node-a' })).resolves.toEqual({
      sessionId: '7',
      fresh: false
    })
  })
})
