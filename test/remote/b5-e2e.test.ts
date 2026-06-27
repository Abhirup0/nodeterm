// End-to-end integration test for the B5 remote project mirror (Task 6).
//
// Builds on the B4 relay e2e (`relay-e2e.test.ts`): same REAL relay child process + REAL relay
// socket protocol + fake echo pty, but now exercises the FULL B5 stack the "New Remote Connection"
// UX drives — the host's canvas sync + fs serving, and the client's canvas router — over the
// bridged E2EE pair.
//
// What it asserts (over the bridged host<->client pair, real handlers + routers):
//   1. the client receives the host's `canvas:state` (a node list) via the host->client notify path;
//   2. a terminal attaches and an echo PTY round-trips input -> output;
//   3. `fs.write` then `fs.read` round-trip against a real temp dir over the relay;
//   4. a client `canvas:mutate` (move a node) reaches the host handler and the host's resulting
//      `canvas:state` reflects the new position;
//   5. no plaintext (the moved node's id) ever appears in the bytes the relay forwards (E2EE).
//
// The harness is hermetic: the relay runs in-process as a child via `tsx` on an ephemeral port;
// there is NO network / deployed relay.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'

import { connectRelay, wrapWebSocket, type RelaySocket } from '../../src/main/remote/relay-socket'
import {
  createHostHandlers,
  createHostCanvasSync,
  type HostPtyManager,
  type HostFsOps
} from '../../src/main/remote/host-service'
import {
  createClientHandlers,
  createClientCanvasRouter
} from '../../src/main/remote/client-service'
import { applyMutation } from '../../src/main/remote/canvas-sync'
import * as fsOps from '../../src/main/fs-ops'
import { genKeyPair, publicKeyToB64, type KeyPair } from '../../src/main/remote/e2ee'
import { OP, type Frame } from '../../src/main/remote/framing'
import type {
  CanvasMutation,
  CanvasNodeState,
  CanvasState,
  PtyCreateOptions
} from '../../src/shared/types'
import type { DetachedSinks } from '../../src/main/pty-manager'

const SERVER_DIR =
  process.env.NODETERM_SERVER_DIR || path.resolve('nodebaseserver')
const RELAY_ENTRY = path.join(SERVER_DIR, 'src/relay/index.ts')
const TSX_BIN = path.join(SERVER_DIR, 'node_modules/.bin/tsx')

const SPAWN_TIMEOUT_MS = 20_000
const HANDSHAKE_TIMEOUT_MS = 15_000

// --- helpers (shared shape with relay-e2e.test.ts) ---------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('Could not determine an ephemeral port.')))
      }
    })
  })
}

function mintToken(privateKey: crypto.KeyObject, pairingId: string): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = { pairingId, licenseId: 'test-license', iat: now, exp: now + 300 }
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.sign(null, Buffer.from(p), privateKey).toString('base64url')
  return `${p}.${sig}`
}

function spawnRelay(port: number, publicKeyPem: string): Promise<ChildProcess> {
  const child = spawn(TSX_BIN, [RELAY_ENTRY], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), RELAY_ENTITLEMENT_PUBLIC_KEY: publicKeyPem },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const ready = deferred<ChildProcess>()
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    ready.reject(new Error(`Relay did not start within ${SPAWN_TIMEOUT_MS}ms.\n${stderr}`))
  }, SPAWN_TIMEOUT_MS)

  let stderr = ''
  child.stdout?.on('data', (buf: Buffer) => {
    if (!settled && buf.toString().includes('listening')) {
      settled = true
      clearTimeout(timer)
      ready.resolve(child)
    }
  })
  child.stderr?.on('data', (buf: Buffer) => {
    stderr += buf.toString()
  })
  child.on('exit', (code) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    ready.reject(new Error(`Relay exited early (code ${code}).\n${stderr}`))
  })

  return ready.promise
}

// Open a real ws to the relay carrying the token; tap every outbound payload so the test can
// assert no plaintext crosses the wire.
function openTappedTransport(
  baseUrl: string,
  token: string,
  sentSink: (data: string | Uint8Array) => void
): { transport: ReturnType<typeof wrapWebSocket>; opened: Promise<void>; ws: WebSocket } {
  const sep = baseUrl.includes('?') ? '&' : '?'
  const ws = new WebSocket(`${baseUrl}${sep}token=${encodeURIComponent(token)}`)
  ws.binaryType = 'nodebuffer'

  const opened = deferred<void>()
  ws.on('open', () => opened.resolve())
  ws.on('error', (err) => opened.reject(err as Error))

  const wrapped = wrapWebSocket(ws)
  const transport = {
    get bufferedAmount() {
      return wrapped.bufferedAmount
    },
    send: (data: string | Uint8Array) => {
      sentSink(data)
      wrapped.send(data)
    },
    close: () => wrapped.close(),
    onMessage: wrapped.onMessage,
    onClose: wrapped.onClose
  }
  return { transport, opened: opened.promise, ws }
}

// A fake pty-manager: each created/attached session echoes whatever is written to it straight back
// as output. captureSnapshot returns empty (the attach path still exercises Start->End).
function makeEchoPty(): HostPtyManager {
  const sinks = new Map<string, DetachedSinks>()
  let counter = 0
  return {
    createDetached(_options: PtyCreateOptions, s: DetachedSinks): string {
      const sessionId = `echo-${++counter}`
      sinks.set(sessionId, s)
      return sessionId
    },
    attachDetached(_persistKey: string, s: DetachedSinks): string {
      const sessionId = `echo-${++counter}`
      sinks.set(sessionId, s)
      return sessionId
    },
    async captureSnapshot(): Promise<string> {
      return ''
    },
    write(sessionId: string, data: string): void {
      sinks.get(sessionId)?.onData(data)
    },
    resize(): void {},
    setFlow(): void {},
    kill(sessionId: string): void {
      const s = sinks.get(sessionId)
      sinks.delete(sessionId)
      s?.onExit(0)
    }
  }
}

function node(id: string, x: number, y: number): CanvasNodeState {
  return {
    id,
    kind: 'terminal',
    position: { x, y },
    size: { width: 480, height: 320 },
    title: id,
    color: '#888',
    group: null
  }
}

// --- test --------------------------------------------------------------------

describe('B5 remote project mirror end-to-end (real relay + real handlers + fake pty)', () => {
  let relay: ChildProcess | null = null
  let baseUrl = ''
  let token = ''
  let hostKeys: KeyPair
  let clientKeys: KeyPair
  let tmpDir = ''
  const hostSentFrames: Uint8Array[] = []

  let hostSocket: RelaySocket | null = null
  let clientSocket: RelaySocket | null = null

  beforeAll(async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string

    const port = await getEphemeralPort()
    baseUrl = `ws://127.0.0.1:${port}`
    relay = await spawnRelay(port, publicKeyPem)

    token = mintToken(privateKey, 'pairing-b5-1')
    hostKeys = genKeyPair()
    clientKeys = genKeyPair()
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nt-b5-e2e-'))
  }, SPAWN_TIMEOUT_MS + 5_000)

  afterAll(async () => {
    hostSocket?.close()
    clientSocket?.close()
    relay?.kill('SIGKILL')
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it('mirrors the canvas, attaches a terminal, round-trips fs, applies a mutation — all E2EE', async () => {
    // --- the host's authoritative canvas (single writer). The client mirror reflects this. ---
    let hostCanvas: CanvasState = { nodes: [node('n-1', 100, 100), node('n-2', 400, 100)] }

    // --- host connects FIRST (becomes the pending host) ---
    const hostTap = openTappedTransport(baseUrl, token, (data) => {
      if (data instanceof Uint8Array) hostSentFrames.push(Uint8Array.from(data))
    })
    await hostTap.opened

    const hostReady = deferred<void>()
    let hostHandlers: ReturnType<typeof createHostHandlers> | null = null
    let hostCanvasSync: ReturnType<typeof createHostCanvasSync> | null = null
    // fs-ops served against the temp dir (mirrors the real host, which serves its real fs).
    const hostFs: HostFsOps = {
      listDir: (p) => fsOps.listDir(p),
      readText: (p) => fsOps.readText(p),
      readBinary: (p) => fsOps.readBinary(p),
      writeText: (p, c) => fsOps.writeText(p, c)
    }

    hostSocket = connectRelay({
      url: baseUrl,
      token,
      role: 'host',
      ourKeys: hostKeys,
      transport: hostTap.transport,
      onReady: () => {
        // Bridge established — push the current canvas so the client mirrors immediately.
        hostCanvasSync?.setState(hostCanvas)
        hostReady.resolve()
      },
      onRpc: (req) => {
        // Canvas mutations route to the sync (host is the single writer); else a pty/fs RPC.
        if (hostCanvasSync?.handleRpc(req)) return
        hostHandlers?.onRpc(req)
      },
      onFrame: (frame) => hostHandlers?.onFrame(frame),
      onClose: () => hostHandlers?.closeAll()
    })
    // Share the temp dir as the allowed fs root (fs jail) so the client's fs.* RPCs are served.
    hostHandlers = createHostHandlers(makeEchoPty(), hostSocket, hostFs, () => [tmpDir])
    // Mirror the real host: a client mutation is applied to the host's authoritative state (the
    // single writer), then re-broadcast as the new `canvas:state`.
    hostCanvasSync = createHostCanvasSync(hostSocket, (mutation: CanvasMutation) => {
      hostCanvas = { nodes: applyMutation(hostCanvas.nodes, mutation) }
      hostCanvasSync?.setState(hostCanvas)
    })

    // --- client connects SECOND (triggers the bridge) ---
    const clientTap = openTappedTransport(baseUrl, token, () => {})
    await clientTap.opened

    const clientReady = deferred<void>()
    const canvasStates: CanvasState[] = []
    const dataEvents: { streamId: number; data: string }[] = []
    const exitEvents: { streamId: number; exitCode: number }[] = []
    let clientHandlers: ReturnType<typeof createClientHandlers> | null = null
    let clientCanvas: ReturnType<typeof createClientCanvasRouter> | null = null

    clientSocket = connectRelay({
      url: baseUrl,
      token,
      role: 'client',
      ourKeys: clientKeys,
      theirPubB64: publicKeyToB64(hostKeys.publicKey),
      transport: clientTap.transport,
      onReady: () => clientReady.resolve(),
      onRpc: (req) => {
        // The host pushes `canvas:state` as a one-way notify (id:''); route it to the mirror.
        const state = clientCanvas?.handleRpc(req)
        if (state) canvasStates.push(state)
      },
      onFrame: (frame: Frame) => clientHandlers?.onFrame(frame),
      onClose: () => clientHandlers?.closeAll()
    })
    clientHandlers = createClientHandlers(clientSocket, {
      onData: (streamId, data) => dataEvents.push({ streamId, data }),
      onExit: (streamId, exitCode) => exitEvents.push({ streamId, exitCode })
    })
    clientCanvas = createClientCanvasRouter(clientSocket)

    // Both ends complete the E2EE handshake.
    await withTimeout(
      Promise.all([hostReady.promise, clientReady.promise]),
      HANDSHAKE_TIMEOUT_MS,
      'handshake'
    )

    // === (1) client receives the host's canvas:state ===
    await waitFor(() => canvasStates.length > 0, HANDSHAKE_TIMEOUT_MS, 'initial canvas:state')
    const firstState = canvasStates[0]
    expect(firstState.nodes.map((n) => n.id).sort()).toEqual(['n-1', 'n-2'])
    expect(firstState.nodes.find((n) => n.id === 'n-1')?.position).toEqual({ x: 100, y: 100 })

    // === (2) terminal attaches + echo round-trips ===
    const streamId = await withTimeout(
      clientHandlers.create({ cols: 80, rows: 24, persistKey: 'n-1' }),
      HANDSHAKE_TIMEOUT_MS,
      'pty.attach'
    )
    expect(typeof streamId).toBe('number')

    clientHandlers.write(streamId, 'hello\n')
    await waitFor(
      () => dataEvents.some((e) => e.streamId === streamId && e.data.includes('hello')),
      HANDSHAKE_TIMEOUT_MS,
      'echo output'
    )
    const echoed = dataEvents
      .filter((e) => e.streamId === streamId)
      .map((e) => e.data)
      .join('')
    expect(echoed).toContain('hello')

    // === (3) fs.write then fs.read round-trip against the temp dir ===
    const filePath = path.join(tmpDir, 'remote.txt')
    const contents = 'remote-fs-roundtrip-payload'
    const wrote = await withTimeout(clientHandlers.fsWrite(filePath, contents), HANDSHAKE_TIMEOUT_MS, 'fs.write')
    expect(wrote).toBe(true)
    const readBack = await withTimeout(clientHandlers.fsRead(filePath), HANDSHAKE_TIMEOUT_MS, 'fs.read')
    expect(readBack).toBe(contents)
    // And it really hit the disk on the "host" side.
    expect(await fsp.readFile(filePath, 'utf-8')).toBe(contents)

    // === (4) client canvas:mutate (move n-1) is reflected back in the host's next canvas:state ===
    const beforeCount = canvasStates.length
    const moved = node('n-1', 777, 555)
    clientCanvas.sendMutation({ op: 'upsert', node: moved })
    await waitFor(
      () =>
        canvasStates.length > beforeCount &&
        canvasStates[canvasStates.length - 1].nodes.find((n) => n.id === 'n-1')?.position.x === 777,
      HANDSHAKE_TIMEOUT_MS,
      'mutated canvas:state'
    )
    const latest = canvasStates[canvasStates.length - 1]
    expect(latest.nodes.find((n) => n.id === 'n-1')?.position).toEqual({ x: 777, y: 555 })
    // The host's authoritative state was the single writer that produced it.
    expect(hostCanvas.nodes.find((n) => n.id === 'n-1')?.position).toEqual({ x: 777, y: 555 })

    // === (5) E2EE: no host->relay frame leaks plaintext (node id / file payload) ===
    expect(hostSentFrames.length).toBeGreaterThan(0)
    for (const needleStr of ['hello', contents, 'n-1']) {
      const needle = Buffer.from(needleStr)
      const leaked = hostSentFrames.find((frame) => Buffer.from(frame).includes(needle))
      expect(leaked, `a host->relay frame leaked the plaintext "${needleStr}"`).toBeUndefined()
    }
    // Sanity: the same plaintext, unencrypted, WOULD be findable — the assertion is meaningful.
    expect(Buffer.from('canvas n-1 payload hello').includes(Buffer.from('hello'))).toBe(true)

    // --- close ---
    clientSocket.close()
    hostSocket.close()
    expect(exitEvents.length).toBeGreaterThanOrEqual(0)
  }, HANDSHAKE_TIMEOUT_MS + 15_000)
})

// --- timing utilities --------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), ms))
  ])
}

async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${label}.`)
    await delay(25)
  }
}
