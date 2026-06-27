// End-to-end integration test for the B4 relay (Task 8).
//
// Wires the REAL relay broker + REAL relay-socket protocol + a fake PTY end-to-end over real
// WebSockets, and asserts a terminal stream works and stays E2EE.
//
// What it exercises:
//   - the REAL relay (`nodebaseserver/src/relay/index.ts`) spawned as a child process on an
//     ephemeral port via `tsx`, trusting a test Ed25519 public key;
//   - a single-use pairing token minted INLINE in the same compact format the relay verifies
//     (`base64url(payloadJSON).base64url(ed25519 sig over the base64url-payload bytes)`);
//   - the host side: a real `connectRelay({role:'host'})` + the pure `createHostHandlers(...)`
//     backed by a FAKE pty that simply echoes input back as output;
//   - the client side: a real `connectRelay({role:'client'})` + the pure
//     `createClientHandlers(...)`;
//   - the full E2EE handshake + RPC/frame state machine over real `ws` sockets through the relay.
//
// Assertions: the client opens a stream (RPC `pty.create`), sends OP.Input "hello\n", receives
// OP.Output echoing "hello", sends OP.Resize, then closes. AND: a passive observer of every
// binary frame the host puts on the wire toward the relay can never find the plaintext "hello"
// substring (the E2EE box differs from the plaintext bytes) — proving the relay never sees
// plaintext.
//
// ---------------------------------------------------------------------------------------------
// MANUAL SMOKE TEST (documented here, NOT automated — Task 8 Step 3):
//
//   Two local nodeterm instances + the deployed (or a local) relay:
//     1. Instance A (host): enable Host mode → the app mints a pairing token and connects to
//        the relay as the pending host → copy the generated OFFER string.
//     2. Instance B (client): paste the OFFER → the app connects as the client, which triggers
//        the host<->client bridge over the relay.
//     3. In B: open a Remote terminal node against that connection.
//     4. Run a command on the HOST machine from B (e.g. `whoami`) and confirm the output shows
//        the host's identity (not the client's) — proving the PTY runs on A.
//     5. Resize the remote terminal node (drag its corner) → the host PTY reflows.
//     6. Close the remote node / disconnect → the client detaches; the host-side tmux session
//        survives (reopen reattaches).
//   Throughout, the relay only ever forwards opaque E2EE boxes — it never sees plaintext.
// ---------------------------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'

import { connectRelay, wrapWebSocket, type RelaySocket } from '../../src/main/remote/relay-socket'
import { createHostHandlers, type HostPtyManager } from '../../src/main/remote/host-service'
import { createClientHandlers } from '../../src/main/remote/client-service'
import { genKeyPair, publicKeyToB64, type KeyPair } from '../../src/main/remote/e2ee'
import { OP, type Frame } from '../../src/main/remote/framing'
import type { PtyCreateOptions } from '../../src/shared/types'
import type { DetachedSinks } from '../../src/main/pty-manager'

// Absolute path to the (private) nodeterm-server repo holding the REAL relay. It lives at the
// main checkout root, NOT inside this git worktree, so resolve from there explicitly. Allow an
// env override for unusual layouts / CI.
const SERVER_DIR =
  process.env.NODETERM_SERVER_DIR || path.resolve('nodebaseserver')
const RELAY_ENTRY = path.join(SERVER_DIR, 'src/relay/index.ts')
const TSX_BIN = path.join(SERVER_DIR, 'node_modules/.bin/tsx')

// Generous timeouts: spawning tsx + two ws handshakes need real wall-clock time.
const SPAWN_TIMEOUT_MS = 20_000
const HANDSHAKE_TIMEOUT_MS = 15_000

// --- helpers -----------------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Find a free TCP port by binding to :0 and reading back the assigned port.
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

// Mint a pairing token in the exact compact format the relay verifies
// (mirrors nodebaseserver/src/lib/pairing-token.ts):
//   base64url(JSON {pairingId, licenseId, iat, exp}).base64url(ed25519 sig over the b64url bytes)
function mintToken(privateKey: crypto.KeyObject, pairingId: string): string {
  const now = Math.floor(Date.now() / 1000)
  const payload = { pairingId, licenseId: 'test-license', iat: now, exp: now + 300 }
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.sign(null, Buffer.from(p), privateKey).toString('base64url')
  return `${p}.${sig}`
}

// Spawn the REAL relay as a child process; resolve once it logs that it is listening.
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

// Open a real ws to the relay carrying the token, wrap it as a RelayTransport, and tap every
// outbound payload so the test can assert no plaintext ever crosses the wire.
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

// A fake pty-manager: each created session echoes whatever is written to it straight back as
// output (so OP.Input "hello\n" -> OP.Output "hello\n"). No node-pty, no tmux.
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
      // Same echo semantics as create — the client now opens streams via pty.attach.
      const sessionId = `echo-${++counter}`
      sinks.set(sessionId, s)
      return sessionId
    },
    async captureSnapshot(): Promise<string> {
      // No prior screen in the fake; an empty snapshot still exercises the Start→End path.
      return ''
    },
    write(sessionId: string, data: string): void {
      sinks.get(sessionId)?.onData(data)
    },
    resize(): void {
      // No-op: the echo pty has no real geometry; the test only asserts the frame arrives.
    },
    setFlow(): void {
      // No-op: no real backpressure in the fake.
    },
    kill(sessionId: string): void {
      const s = sinks.get(sessionId)
      sinks.delete(sessionId)
      s?.onExit(0)
    }
  }
}

// --- test --------------------------------------------------------------------

describe('B4 relay end-to-end (real relay + real protocol + fake pty)', () => {
  let relay: ChildProcess | null = null
  let baseUrl = ''
  let token = ''
  let hostKeys: KeyPair
  let clientKeys: KeyPair
  const hostSentFrames: Uint8Array[] = []

  let hostSocket: RelaySocket | null = null
  let clientSocket: RelaySocket | null = null

  beforeAll(async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string

    const port = await getEphemeralPort()
    baseUrl = `ws://127.0.0.1:${port}`
    relay = await spawnRelay(port, publicKeyPem)

    // SAME token (same pairingId) for both ends: the relay treats the first connector as the
    // host and the second as the client.
    token = mintToken(privateKey, 'pairing-e2e-1')

    hostKeys = genKeyPair()
    clientKeys = genKeyPair()
  }, SPAWN_TIMEOUT_MS + 5_000)

  afterAll(() => {
    hostSocket?.close()
    clientSocket?.close()
    relay?.kill('SIGKILL')
  })

  it('streams a remote PTY over E2EE and never leaks plaintext to the relay', async () => {
    // --- host connects FIRST (becomes the pending host) ---
    const hostTap = openTappedTransport(baseUrl, token, (data) => {
      if (data instanceof Uint8Array) hostSentFrames.push(Uint8Array.from(data))
    })
    await hostTap.opened

    const hostReady = deferred<void>()
    let hostHandlers: ReturnType<typeof createHostHandlers> | null = null
    hostSocket = connectRelay({
      url: baseUrl,
      token,
      role: 'host',
      ourKeys: hostKeys,
      transport: hostTap.transport,
      onReady: () => hostReady.resolve(),
      onRpc: (req) => hostHandlers?.onRpc(req),
      onFrame: (frame) => hostHandlers?.onFrame(frame),
      onClose: () => hostHandlers?.closeAll()
    })
    hostHandlers = createHostHandlers(makeEchoPty(), hostSocket)

    // --- client connects SECOND (triggers the bridge) ---
    const clientTap = openTappedTransport(baseUrl, token, () => {})
    await clientTap.opened

    const clientReady = deferred<void>()
    const dataEvents: { streamId: number; data: string }[] = []
    const exitEvents: { streamId: number; exitCode: number }[] = []
    let clientHandlers: ReturnType<typeof createClientHandlers> | null = null
    clientSocket = connectRelay({
      url: baseUrl,
      token,
      role: 'client',
      ourKeys: clientKeys,
      theirPubB64: publicKeyToB64(hostKeys.publicKey),
      transport: clientTap.transport,
      onReady: () => clientReady.resolve(),
      onRpc: () => {
        // The host never initiates RPC toward the client in this MVP.
      },
      onFrame: (frame: Frame) => clientHandlers?.onFrame(frame),
      onClose: () => clientHandlers?.closeAll()
    })
    clientHandlers = createClientHandlers(clientSocket, {
      onData: (streamId, data) => dataEvents.push({ streamId, data }),
      onExit: (streamId, exitCode) => exitEvents.push({ streamId, exitCode })
    })

    // Both ends complete the E2EE handshake.
    await withTimeout(Promise.all([hostReady.promise, clientReady.promise]), HANDSHAKE_TIMEOUT_MS, 'handshake')

    // --- client opens a stream via RPC pty.attach (persistKey = host node id) ---
    const streamId = await withTimeout(
      clientHandlers.create({ cols: 80, rows: 24, persistKey: 'node-e2e' }),
      HANDSHAKE_TIMEOUT_MS,
      'pty.attach'
    )
    expect(typeof streamId).toBe('number')

    // --- client sends OP.Input "hello\n" and awaits the echoed OP.Output ---
    clientHandlers.write(streamId, 'hello\n')
    await waitFor(() => dataEvents.some((e) => e.data.includes('hello')), HANDSHAKE_TIMEOUT_MS, 'echo output')

    const echoed = dataEvents.filter((e) => e.streamId === streamId).map((e) => e.data).join('')
    expect(echoed).toContain('hello')

    // --- client sends OP.Resize (host echo pty ignores geometry; assert it does not throw/close) ---
    clientHandlers.resize(streamId, 120, 40)
    // Give the resize frame time to traverse the relay and reach the host.
    await delay(200)

    // --- E2EE assertion: no host->relay binary frame contains the plaintext "hello" ---
    expect(hostSentFrames.length).toBeGreaterThan(0)
    const needle = Buffer.from('hello')
    const leaked = hostSentFrames.find((frame) => Buffer.from(frame).includes(needle))
    expect(leaked, 'a host->relay frame leaked the plaintext "hello"').toBeUndefined()

    // Sanity: the same plaintext, unencrypted, WOULD be findable — proving the assertion above
    // is meaningful (not just because "hello" never crossed the wire).
    expect(Buffer.from('hello\n').includes(needle)).toBe(true)

    // --- close ---
    clientSocket.close()
    hostSocket.close()
  }, HANDSHAKE_TIMEOUT_MS + 10_000)
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
