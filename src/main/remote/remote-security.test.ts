// Security regression tests for the remote subsystem hardening:
//   R1 — host serves no `pty.create`; `fs.*` is confined to the shared roots.
//   R2 — the channel SAS is deterministic + identical on both peers.
//   R3 — replayed/reordered encrypted boxes are dropped (per-direction monotonic counter).
import { describe, expect, it, vi } from 'vitest'
import { createHostHandlers, type HostFsOps, type HostPtyManager, type HostRelaySocket } from './host-service'
import { genKeyPair, deriveSharedKey, sasFromSharedKey, publicKeyToB64 } from './e2ee'
import { connectRelay, type RelaySocket, type RelayTransport } from './relay-socket'
import { OP, type Frame } from './framing'

// --- R1: pty.create rejected + fs jail --------------------------------------

function makeHostFakes() {
  const responses: Array<{ id: string; ok: boolean; body: unknown }> = []
  const socket: HostRelaySocket = {
    respond: (id, ok, body) => responses.push({ id, ok, body }),
    sendFrame: () => true
  }
  const reads: string[] = []
  const fs: HostFsOps = {
    listDir: async (p) => {
      reads.push(p)
      return [{ name: 'x', isDirectory: false } as never]
    },
    readText: async (p) => {
      reads.push(p)
      return 'secret'
    },
    readBinary: async () => '',
    writeText: async () => true
  }
  const pty = {
    createDetached: vi.fn(() => 'sess'),
    attachDetached: vi.fn(() => 'sess'),
    captureSnapshot: vi.fn(async () => ''),
    write: vi.fn(),
    resize: vi.fn(),
    setFlow: vi.fn(),
    kill: vi.fn()
  } as unknown as HostPtyManager
  return { socket, responses, fs, reads, pty }
}

describe('R1: remote pty.create is not served', () => {
  it('responds with an error and never spawns a PTY', () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const handlers = createHostHandlers(pty, socket, fs, () => ['/work'])
    handlers.onRpc({ id: '1', method: 'pty.create', params: { shell: '/bin/sh', cwd: '/' } })
    expect(responses).toEqual([
      { id: '1', ok: false, body: { message: expect.stringContaining('not permitted') } }
    ])
    expect((pty.createDetached as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })
})

describe('R1: fs.* is confined to the shared roots', () => {
  it('denies a path outside the roots (no fs-ops call, empty result)', async () => {
    const { socket, responses, fs, reads } = makeHostFakes()
    const handlers = createHostHandlers({} as HostPtyManager, socket, fs, () => ['/work'])
    handlers.onRpc({ id: '1', method: 'fs.read', params: { path: '/Users/me/.ssh/id_ed25519' } })
    await Promise.resolve()
    expect(reads).toEqual([]) // fs-ops never touched
    expect(responses).toEqual([{ id: '1', ok: true, body: { content: '' } }])
  })

  it('denies a ../ traversal escape from a root', async () => {
    const { socket, responses, fs, reads } = makeHostFakes()
    const handlers = createHostHandlers({} as HostPtyManager, socket, fs, () => ['/work'])
    handlers.onRpc({ id: '1', method: 'fs.read', params: { path: '/work/../etc/passwd' } })
    await Promise.resolve()
    expect(reads).toEqual([])
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { content: '' } })
  })

  it('allows a path inside a root', async () => {
    const { socket, responses, fs, reads } = makeHostFakes()
    const handlers = createHostHandlers({} as HostPtyManager, socket, fs, () => ['/work'])
    handlers.onRpc({ id: '1', method: 'fs.read', params: { path: '/work/src/app.ts' } })
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toEqual(['/work/src/app.ts'])
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { content: 'secret' } })
  })

  it('denies everything when no roots are shared (deny-by-default)', async () => {
    const { socket, responses, fs, reads } = makeHostFakes()
    const handlers = createHostHandlers({} as HostPtyManager, socket, fs, () => [])
    handlers.onRpc({ id: '1', method: 'fs.list', params: { path: '/work' } })
    await Promise.resolve()
    expect(reads).toEqual([])
    expect(responses[0]).toEqual({ id: '1', ok: true, body: { entries: [] } })
  })
})

// --- projects.list: read-only browse RPC ------------------------------------

describe('projects.list serves the host projects blob', () => {
  it('responds ok with the listProjects output', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const listProjects = vi.fn(async () => 'FIXTURE')
    const handlers = createHostHandlers(pty, socket, fs, () => [], listProjects)
    handlers.onRpc({ id: '1', method: 'projects.list', params: undefined })
    await Promise.resolve()
    await Promise.resolve()
    expect(listProjects).toHaveBeenCalledTimes(1)
    expect(responses).toEqual([{ id: '1', ok: true, body: { output: 'FIXTURE' } }])
  })

  it('defaults to an empty blob when no provider is injected (4-arg call)', async () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const handlers = createHostHandlers(pty, socket, fs, () => [])
    handlers.onRpc({ id: '2', method: 'projects.list', params: undefined })
    await Promise.resolve()
    await Promise.resolve()
    expect(responses).toEqual([{ id: '2', ok: true, body: { output: '' } }])
  })
})

// --- R2: SAS determinism -----------------------------------------------------

describe('R2: channel SAS', () => {
  it('is identical for both peers and stable, formatted NNN NNN', () => {
    const host = genKeyPair()
    const client = genKeyPair()
    const hostShared = deriveSharedKey(publicKeyToB64(client.publicKey), host.secretKey)
    const clientShared = deriveSharedKey(publicKeyToB64(host.publicKey), client.secretKey)
    const a = sasFromSharedKey(hostShared)
    const b = sasFromSharedKey(clientShared)
    expect(a).toBe(b)
    expect(a).toMatch(/^\d{3} \d{3}$/)
    expect(sasFromSharedKey(hostShared)).toBe(a) // deterministic
  })
})

// --- R3: replay protection (end-to-end over paired fake transports) ----------

// A pair of in-process transports wired host<->client. Records every binary box delivered to the
// client so a test can re-deliver (replay) it. Handshake control strings pass through too.
function makeTransportPair() {
  let hostOnMsg: ((d: unknown) => void) | null = null
  let clientOnMsg: ((d: unknown) => void) | null = null
  const toClient: Uint8Array[] = []
  const host: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => clientOnMsg?.(d),
    close: () => {},
    onMessage: (cb) => (hostOnMsg = cb),
    onClose: () => {}
  }
  const client: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => hostOnMsg?.(d),
    close: () => {},
    onMessage: (cb) => (clientOnMsg = cb),
    onClose: () => {}
  }
  // Capture host→client binary boxes by wrapping host.send.
  const realHostSend = host.send
  host.send = (d) => {
    if (d instanceof Uint8Array) toClient.push(d)
    realHostSend(d)
  }
  return {
    host,
    client,
    replayToClient: (box: Uint8Array) => clientOnMsg?.(box),
    capturedToClient: toClient
  }
}

describe('R3: replayed encrypted frames are dropped', () => {
  it('delivers a frame once; a replay of the same box is ignored', () => {
    const hostKeys = genKeyPair()
    const clientKeys = genKeyPair()
    const pair = makeTransportPair()

    let hostSocket: RelaySocket | null = null
    const clientFrames: Frame[] = []

    // Host first (passive), then client (sends hello → drives the synchronous handshake).
    hostSocket = connectRelay({
      url: 'x',
      token: 't',
      role: 'host',
      ourKeys: hostKeys,
      transport: pair.host,
      onReady: () => {},
      onRpc: () => {},
      onFrame: () => {},
      onClose: () => {}
    })
    connectRelay({
      url: 'x',
      token: 't',
      role: 'client',
      ourKeys: clientKeys,
      theirPubB64: publicKeyToB64(hostKeys.publicKey),
      transport: pair.client,
      onReady: () => {},
      onRpc: () => {},
      onFrame: (f) => clientFrames.push(f),
      onClose: () => {}
    })

    // Host sends one output frame to the client.
    const ok = hostSocket.sendFrame(OP.Output, 1, 0, new TextEncoder().encode('hi'))
    expect(ok).toBe(true)
    expect(clientFrames).toHaveLength(1)

    // The last captured host→client box is that frame. Replay it verbatim.
    const lastBox = pair.capturedToClient[pair.capturedToClient.length - 1]
    pair.replayToClient(lastBox)
    expect(clientFrames).toHaveLength(1) // dropped — not re-delivered
  })
})

// Scrolling belongs to tmux (mouse on, alternate screen), and the phone cannot deliver the wheel
// itself — its emulator swallows the gesture — so it asks the host to write it into the stream's
// pty, which IS a tmux client. `lines` and the stream target both come off the wire.
describe('pty.scroll drives tmux through the session pty', () => {
  const attach = (handlers: ReturnType<typeof createHostHandlers>): void => {
    handlers.onRpc({ id: 'a', method: 'pty.attach', params: { nodeId: 'node-a', cols: 80, rows: 24 } })
  }
  const writes = (pty: HostPtyManager): string[] =>
    (pty.write as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2] as string)

  it('writes one SGR wheel event per notch, up or down', () => {
    const { socket, fs, pty } = makeHostFakes()
    const handlers = createHostHandlers(pty, socket, fs, () => ['/work'])
    attach(handlers)
    handlers.onRpc({ id: '1', method: 'pty.scroll', params: { streamId: 1, dir: 'up', lines: 3 } })
    expect(writes(pty)).toEqual(['\x1b[<64;1;1M', '\x1b[<64;1;1M', '\x1b[<64;1;1M'])
    handlers.onRpc({ id: '2', method: 'pty.scroll', params: { streamId: 1, dir: 'down', lines: 1 } })
    expect(writes(pty).at(-1)).toBe('\x1b[<65;1;1M')
  })

  it('clamps a hostile `lines` (it arrives from a remote client) and ignores an unknown stream', () => {
    const { socket, responses, fs, pty } = makeHostFakes()
    const handlers = createHostHandlers(pty, socket, fs, () => ['/work'])
    attach(handlers)
    handlers.onRpc({ id: '1', method: 'pty.scroll', params: { streamId: 1, dir: 'up', lines: 1e9 } })
    expect(writes(pty)).toHaveLength(20) // capped, not a million writes
    ;(pty.write as ReturnType<typeof vi.fn>).mockClear()
    handlers.onRpc({ id: '2', method: 'pty.scroll', params: { streamId: 1, lines: -5 } })
    expect(writes(pty)).toHaveLength(1) // floored at one notch
    ;(pty.write as ReturnType<typeof vi.fn>).mockClear()
    // An unknown streamId is a no-op, and still answers — never a hang.
    handlers.onRpc({ id: '3', method: 'pty.scroll', params: { streamId: 99, dir: 'up', lines: 2 } })
    expect(pty.write).not.toHaveBeenCalled()
    expect(responses.at(-1)).toMatchObject({ id: '3', ok: true })
  })
})
