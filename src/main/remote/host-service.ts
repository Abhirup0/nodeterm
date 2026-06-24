// Host service — serve local PTYs over the relay (main process).
//
// On "host mode" the app: (1) gates on a valid Pro entitlement, (2) mints a single-use
// pairing token from our API with the stored entitlement, (3) connects to the relay as the
// HOST (so it becomes the pending host the client later joins to trigger the bridge), and
// (4) returns the pairing OFFER string for the user to hand to a client.
//
// While connected, the host maps the client's E2EE RPC/frames onto the existing pty-manager:
//   - RPC `pty.create {cols, rows, cwd?, shell?, persistKey?, agentId?}` -> `createDetached`,
//     returning `{ streamId }`. The PTY's output is piped into `OP.Output` frames; its exit
//     into an `OP.Error` frame (then the stream is dropped).
//   - `OP.Input`  frame -> `write(sessionId, <utf-8 payload>)`
//   - `OP.Resize` frame -> `resize(sessionId, cols, rows)` (payload = 2x uint16 LE)
//   - RPC `pty.kill {streamId}` -> `kill(sessionId)`
// Output backpressure: when `sendFrame` returns false the host pauses the PTY via `setFlow`
// and resumes it on the next successful send.
//
// This file is glue over already-tested units (relay-socket, framing, pairing, pty-manager).
// The pure RPC/frame -> pty-manager mapping lives in `createHostHandlers` so it is unit-
// testable with fakes; `initRemoteHost` wires it to IPC, the license gate, and the API call.

import { promises as fs } from 'fs'
import path from 'path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import type { CanvasMutation, CanvasState, PtyCreateOptions } from '../../shared/types'
import type { AgentId } from '../../shared/agents/config'
import { PtyManager, type DetachedSinks } from '../pty-manager'
import { getStoredEntitlement, isPremium } from '../license'
import { genKeyPair, publicKeyToB64, type KeyPair } from './e2ee'
import { OP, type Frame } from './framing'
import { encodeOffer } from './pairing'
import { connectRelay, type RelaySocket, type RpcRequest } from './relay-socket'

// Default relay endpoint; `NODETERM_RELAY_URL` overrides it (mirrors license.ts's API_BASE /
// CHECKOUT_URL env-override pattern — used both as the dev gate and for local testing).
const RELAY_URL = process.env.NODETERM_RELAY_URL || 'wss://relay.nodeterm.dev'

const API_BASE = process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// --- pure host handlers (RPC/frame <-> pty-manager) -------------------------

// The slice of pty-manager the host needs. PtyManager satisfies this; tests pass a fake.
export interface HostPtyManager {
  createDetached(options: PtyCreateOptions, sinks: DetachedSinks): string
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  setFlow(sessionId: string, resume: boolean): void
  kill(sessionId: string): void
}

// The slice of RelaySocket the host needs to answer the client.
export interface HostRelaySocket {
  respond(id: string, ok: boolean, body: unknown): void
  sendFrame(op: number, streamId: number, seq: number, payload: Uint8Array): boolean
}

export interface HostHandlers {
  onRpc(req: RpcRequest): void
  onFrame(frame: Frame): void
  /** Kill every live PTY this host opened (called on disconnect / stop). */
  closeAll(): void
}

interface Stream {
  sessionId: string
  /** Outbound OP.Output sequence counter. */
  seq: number
  /** True while the PTY is paused due to relay backpressure. */
  paused: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Build the RPC/frame router that maps a client's requests onto a pty-manager. Pure over its
 * two injected dependencies (no sockets, no Electron) so it can be unit-tested with fakes.
 *
 * `nextStreamId` lets tests assert deterministic ids; production uses a monotonic counter.
 */
export function createHostHandlers(pty: HostPtyManager, socket: HostRelaySocket): HostHandlers {
  // streamId -> Stream. PTY callbacks close over their own `streamId` directly, so no
  // reverse (sessionId -> streamId) index is needed.
  const streams = new Map<number, Stream>()
  let streamCounter = 0

  function dropStream(streamId: number): void {
    streams.delete(streamId)
  }

  function handleCreate(req: RpcRequest): void {
    const p = asRecord(req.params)
    const options: PtyCreateOptions = {
      cols: Math.max(1, num(p.cols, 80)),
      rows: Math.max(1, num(p.rows, 24)),
      cwd: str(p.cwd),
      shell: str(p.shell),
      persistKey: str(p.persistKey),
      agentId: str(p.agentId) as AgentId | undefined
    }

    const streamId = ++streamCounter
    const stream: Stream = { sessionId: '', seq: 0, paused: false }

    const sinks: DetachedSinks = {
      onData: (data) => {
        const bytes = textEncoder.encode(data)
        const ok = socket.sendFrame(OP.Output, streamId, stream.seq++, bytes)
        if (!ok && !stream.paused) {
          // Relay buffer is full — pause the PTY so the OS pipe backpressures the producer.
          stream.paused = true
          pty.setFlow(stream.sessionId, false)
        } else if (ok && stream.paused) {
          stream.paused = false
          pty.setFlow(stream.sessionId, true)
        }
      },
      onExit: (exitCode) => {
        // Signal exit as an OP.Error frame carrying the code, then forget the stream.
        socket.sendFrame(
          OP.Error,
          streamId,
          stream.seq++,
          textEncoder.encode(JSON.stringify({ exitCode }))
        )
        dropStream(streamId)
      }
    }

    let sessionId: string
    try {
      sessionId = pty.createDetached(options, sinks)
    } catch (err) {
      socket.respond(req.id, false, { message: (err as Error).message })
      return
    }
    stream.sessionId = sessionId
    streams.set(streamId, stream)
    socket.respond(req.id, true, { streamId })
  }

  function handleKill(req: RpcRequest): void {
    const streamId = num(asRecord(req.params).streamId, -1)
    const stream = streams.get(streamId)
    if (stream) {
      pty.kill(stream.sessionId)
      dropStream(streamId)
    }
    socket.respond(req.id, true, {})
  }

  return {
    onRpc(req) {
      switch (req.method) {
        case 'pty.create':
          handleCreate(req)
          break
        case 'pty.kill':
          handleKill(req)
          break
        default:
          socket.respond(req.id, false, { message: `Unknown method: ${req.method}` })
      }
    },
    onFrame(frame) {
      const stream = streams.get(frame.streamId)
      if (!stream) return
      if (frame.op === OP.Input) {
        pty.write(stream.sessionId, textDecoder.decode(frame.payload))
        return
      }
      if (frame.op === OP.Resize) {
        // Payload is 2x uint16 LE: cols, rows.
        if (frame.payload.length >= 4) {
          const view = new DataView(
            frame.payload.buffer,
            frame.payload.byteOffset,
            frame.payload.byteLength
          )
          pty.resize(stream.sessionId, view.getUint16(0, true), view.getUint16(2, true))
        }
      }
    },
    closeAll() {
      for (const stream of streams.values()) {
        pty.kill(stream.sessionId)
      }
      streams.clear()
    }
  }
}

// --- pure canvas mirror sync (host renderer <-> relay) -----------------------

// The wire methods for the host-authoritative canvas mirror (host->client push of the
// full state, client->host one-way mutation command). Kept as constants so both sides agree.
export const CANVAS_STATE_METHOD = 'canvas:state'
export const CANVAS_MUTATE_METHOD = 'canvas:mutate'

// The slice of RelaySocket the canvas sync needs: a one-way host->client push.
export interface CanvasNotifySocket {
  notify(method: string, params?: unknown): boolean
}

export interface HostCanvasSync {
  /** Record the latest active-project canvas snapshot and broadcast it to the client. */
  setState(state: CanvasState): void
  /** Push the current known state now (e.g. on a fresh client connect). No-op if none yet. */
  broadcastCurrent(): void
  /** Route an inbound client RPC/notify; returns the mutation when it is a canvas:mutate. */
  handleRpc(req: RpcRequest): CanvasMutation | null
}

/**
 * Build the host-side canvas mirror router. Pure over its two injected dependencies (the relay
 * socket for host->client push + a sink the IPC layer forwards to the host renderer), so it is
 * unit-testable with fakes — no Electron, no real socket. The host's React Flow stays the single
 * writer: client mutations are surfaced via `onMutation` and applied there, which re-triggers the
 * renderer's debounced `setState` broadcast.
 */
export function createHostCanvasSync(
  socket: CanvasNotifySocket,
  onMutation: (mutation: CanvasMutation) => void
): HostCanvasSync {
  let current: CanvasState | null = null

  function broadcastCurrent(): void {
    if (current) socket.notify(CANVAS_STATE_METHOD, current)
  }

  return {
    setState(state) {
      current = state
      broadcastCurrent()
    },
    broadcastCurrent,
    handleRpc(req) {
      if (req.method !== CANVAS_MUTATE_METHOD) return null
      const mutation = req.params as CanvasMutation
      if (!mutation || typeof mutation !== 'object' || typeof (mutation as { op?: unknown }).op !== 'string') {
        return null
      }
      onMutation(mutation)
      return mutation
    }
  }
}

// --- pairing-token mint ------------------------------------------------------

interface PairTokenResponse {
  pairingId: string
  pairingToken: string
  exp: number
}

// Mint a single-use pairing token from our API, proving entitlement with the stored token.
async function mintPairingToken(entitlement: string): Promise<PairTokenResponse> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  let res: Response
  try {
    res = await fetch(`${API_BASE}/v1/pair/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entitlement }),
      signal: ctrl.signal
    })
  } catch {
    throw new Error('Could not reach the pairing server.')
  } finally {
    clearTimeout(timer)
  }
  const json = (await res.json().catch(() => ({}))) as Partial<PairTokenResponse> & { error?: string }
  if (!res.ok || !json.pairingToken) {
    throw new Error(json.error ? `Pairing failed: ${json.error}` : 'Pairing failed.')
  }
  return { pairingId: json.pairingId ?? '', pairingToken: json.pairingToken, exp: json.exp ?? 0 }
}

// --- persisted host keypair --------------------------------------------------

function keyFile(): string {
  return path.join(app.getPath('userData'), 'remote-host-key.json')
}

// Load the long-lived host NaCl keypair, generating + persisting it on first use. The public
// key is pinned in every offer, so it must be stable across runs.
async function loadOrCreateKeyPair(): Promise<KeyPair> {
  try {
    const raw = JSON.parse(await fs.readFile(keyFile(), 'utf-8')) as {
      publicKey?: string
      secretKey?: string
    }
    if (raw.publicKey && raw.secretKey) {
      return {
        publicKey: Uint8Array.from(Buffer.from(raw.publicKey, 'base64')),
        secretKey: Uint8Array.from(Buffer.from(raw.secretKey, 'base64'))
      }
    }
  } catch {
    // No (valid) stored key — generate a fresh one below.
  }
  const keys = genKeyPair()
  await fs
    .writeFile(
      keyFile(),
      JSON.stringify({
        publicKey: Buffer.from(keys.publicKey).toString('base64'),
        secretKey: Buffer.from(keys.secretKey).toString('base64')
      }),
      // 0o600: the host's NaCl secret key is its E2EE identity — owner read/write only.
      { encoding: 'utf-8', mode: 0o600 }
    )
    .catch(() => {})
  return keys
}

// --- dev gate ----------------------------------------------------------------

// Never hit the real relay/API from an unpackaged build unless a relay is explicitly targeted
// (mirrors license.ts's `allowed()` gate). Packaged builds are always allowed.
function relayAllowed(): boolean {
  return app.isPackaged || !!process.env.NODETERM_RELAY_URL
}

// --- IPC wiring --------------------------------------------------------------

/**
 * Wire the host-mode IPC. `remote:host:start` gates on Pro, mints a pairing token, connects to
 * the relay as host, and returns the offer string. `remote:host:stop` closes the relay socket
 * (which kills the served PTYs and drops the client's access).
 */
export function initRemoteHost(win: BrowserWindow, ptyManager: PtyManager): void {
  let socket: RelaySocket | null = null
  let handlers: HostHandlers | null = null
  let canvasSync: HostCanvasSync | null = null
  // Latest snapshot pushed from the renderer, kept across (re)connects so a freshly joined
  // client always gets the current state even if it connected after the last edit.
  let latestCanvas: CanvasState | null = null

  function send(channel: string, ...args: unknown[]): void {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  function teardown(): void {
    if (broadcastTimer) {
      clearTimeout(broadcastTimer)
      broadcastTimer = null
    }
    handlers?.closeAll()
    handlers = null
    canvasSync = null
    socket?.close()
    socket = null
  }

  // Re-broadcasting the *full* canvas on every renderer keystroke would be wasteful; the
  // renderer already debounces, but a small main-side debounce coalesces bursts further.
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleBroadcast(): void {
    if (broadcastTimer) return
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null
      if (latestCanvas) canvasSync?.setState(latestCanvas)
    }, 120)
    broadcastTimer.unref?.()
  }

  // Renderer pushes its serialized active-project canvas; remember it and (debounced) broadcast.
  // Safe to receive when not hosting — it just updates the snapshot a future client will get.
  ipcMain.on(IPC.remoteHostCanvasState, (_e, state: CanvasState) => {
    latestCanvas = state
    scheduleBroadcast()
  })

  ipcMain.handle(IPC.remoteHostStart, async (): Promise<{ offer: string }> => {
    if (!isPremium()) {
      throw new Error('Remote access requires nodeterm Pro.')
    }
    if (!relayAllowed()) {
      throw new Error('Remote access is unavailable in development builds (set NODETERM_RELAY_URL).')
    }
    const entitlement = getStoredEntitlement()
    if (!entitlement) {
      throw new Error('No entitlement found — please re-activate nodeterm Pro.')
    }

    // Already hosting → tear the old session down before starting a fresh one.
    teardown()

    const keys = await loadOrCreateKeyPair()
    const { pairingToken } = await mintPairingToken(entitlement)

    // Connect FIRST and register as the pending host (the client joins later to trigger the
    // bridge). The RPC/frame handlers are bound to this socket once it is created.
    socket = connectRelay({
      url: RELAY_URL,
      token: pairingToken,
      role: 'host',
      ourKeys: keys,
      onReady: () => {
        // Bridge established with a client — push the current canvas so it mirrors immediately.
        if (latestCanvas) canvasSync?.setState(latestCanvas)
      },
      onRpc: (req) => {
        // Canvas mutations route to the canvas sync (which forwards them to the host renderer,
        // the single writer); everything else is a pty RPC.
        if (canvasSync?.handleRpc(req)) return
        handlers?.onRpc(req)
      },
      onFrame: (frame) => handlers?.onFrame(frame),
      onClose: () => {
        // The client (or relay) dropped — kill served PTYs. relay-socket may reconnect; the
        // handlers stay bound to the same socket object across reconnects.
        handlers?.closeAll()
      }
    })
    handlers = createHostHandlers(ptyManager, socket)
    // The host renderer applies inbound client mutations to its React Flow (single writer).
    canvasSync = createHostCanvasSync(socket, (mutation) =>
      send(IPC.remoteHostApplyMutation, mutation)
    )

    return {
      offer: encodeOffer({
        relayEndpoint: RELAY_URL,
        pairingToken,
        hostPublicKeyB64: publicKeyToB64(keys.publicKey)
      })
    }
  })

  ipcMain.handle(IPC.remoteHostStop, () => {
    teardown()
  })
}
