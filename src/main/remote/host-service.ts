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
import type { CanvasMutation, CanvasState, DirEntry, PtyCreateOptions } from '../../shared/types'
import type { AgentId } from '../../shared/agents/config'
import { PtyManager, type DetachedSinks } from '../pty-manager'
import * as fsOps from '../fs-ops'
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
  /** Attach a relay-served PTY to the EXISTING tmux session for a node id (create if absent). */
  attachDetached(
    persistKey: string,
    sinks: DetachedSinks,
    options?: Omit<PtyCreateOptions, 'persistKey'>
  ): string
  /** Current visible screen of a node's tmux session, for the attach snapshot. */
  captureSnapshot(persistKey: string): Promise<string>
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

// The slice of fs-ops the host serves over `fs.*` RPC. Defaults to the real fs-ops; tests inject
// a fake (or just point it at a temp dir). Mirrors the renderer's `FsApi` contract exactly so a
// remote Explorer/Editor behaves the same as a local one.
export interface HostFsOps {
  listDir(dirPath: string): Promise<DirEntry[]>
  readText(filePath: string): Promise<string>
  readBinary(filePath: string): Promise<string>
  writeText(filePath: string, content: string): Promise<boolean>
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
/**
 * Lexically resolve `target` and confirm it sits inside one of `roots` (or equals a root). Uses
 * path.resolve so `..` traversal is normalized away — a remote client cannot reach `/etc/passwd`
 * or `~/.ssh` via `../../`. (Symlinks inside a shared root are not chased; the shared roots are
 * the user's own project directories.)
 */
function isWithinRoots(target: string, roots: string[]): boolean {
  if (!target) return false
  const resolved = path.resolve(target)
  for (const root of roots) {
    if (!root) continue
    const r = path.resolve(root)
    if (resolved === r || resolved.startsWith(r + path.sep)) return true
  }
  return false
}

export function createHostHandlers(
  pty: HostPtyManager,
  socket: HostRelaySocket,
  fs: HostFsOps = fsOps,
  // Directories the remote client may read/write within. Empty ⇒ no filesystem access is served
  // (deny-by-default). Production passes the cwds of the host's shared canvas nodes.
  getRoots: () => string[] = () => []
): HostHandlers {
  // streamId -> Stream. PTY callbacks close over their own `streamId` directly, so no
  // reverse (sessionId -> streamId) index is needed.
  const streams = new Map<number, Stream>()
  let streamCounter = 0

  function dropStream(streamId: number): void {
    streams.delete(streamId)
  }

  // Build the output/exit sinks for a new stream: pipe PTY output into OP.Output frames (with
  // relay backpressure -> setFlow pause/resume) and PTY exit into an OP.Error frame.
  function makeSinks(streamId: number, stream: Stream): DetachedSinks {
    return {
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
  }

  // Reassembled snapshot is sent as one or more OP.SnapshotChunk frames between Start and End.
  // 256 KB keeps each chunk well under the relay's per-frame limits while a full-screen capture
  // (with colors) stays small in practice.
  const SNAPSHOT_CHUNK_BYTES = 256 * 1024

  function sendSnapshot(streamId: number, stream: Stream, text: string): void {
    socket.sendFrame(OP.SnapshotStart, streamId, stream.seq++, new Uint8Array(0))
    const bytes = textEncoder.encode(text)
    for (let i = 0; i < bytes.length; i += SNAPSHOT_CHUNK_BYTES) {
      socket.sendFrame(
        OP.SnapshotChunk,
        streamId,
        stream.seq++,
        bytes.subarray(i, i + SNAPSHOT_CHUNK_BYTES)
      )
    }
    socket.sendFrame(OP.SnapshotEnd, streamId, stream.seq++, new Uint8Array(0))
  }

  /**
   * Attach a mirrored terminal to the host's EXISTING tmux session for `nodeId`: respond with the
   * streamId, send a SNAPSHOT of the current screen (so the client paints it before any live
   * output), then start streaming live output via `attachDetached`. Falls back to plain create
   * semantics when no session exists yet (attachDetached creates one; the snapshot is empty).
   */
  function handleAttach(req: RpcRequest): void {
    const p = asRecord(req.params)
    const nodeId = str(p.nodeId) ?? str(p.persistKey)
    if (!nodeId) {
      socket.respond(req.id, false, { message: 'pty.attach requires a nodeId.' })
      return
    }
    const cols = Math.max(1, num(p.cols, 80))
    const rows = Math.max(1, num(p.rows, 24))

    const streamId = ++streamCounter
    const stream: Stream = { sessionId: '', seq: 0, paused: false }
    const sinks = makeSinks(streamId, stream)

    // Reserve the stream and respond up front so the client can route Input/Resize frames; the
    // snapshot + live attach then proceed. Capturing the screen is async (a tmux side-call).
    streams.set(streamId, stream)
    socket.respond(req.id, true, { streamId })

    void pty
      .captureSnapshot(nodeId)
      .catch(() => '')
      .then((snapshot) => {
        // The stream may have been killed/closed while the capture was in flight.
        if (!streams.has(streamId)) return
        // Snapshot first (current screen) — then live output begins on attach.
        sendSnapshot(streamId, stream, snapshot)
        try {
          stream.sessionId = pty.attachDetached(nodeId, sinks, { cols, rows })
        } catch {
          // Attach failed (e.g. tmux unavailable) — surface as an exit so the client tears down.
          socket.sendFrame(
            OP.Error,
            streamId,
            stream.seq++,
            textEncoder.encode(JSON.stringify({ exitCode: 1 }))
          )
          dropStream(streamId)
        }
      })
  }

  // Serve a `fs.*` RPC by calling the shared fs-ops on the host's real filesystem and responding
  // with the same shape the renderer's `FsApi` expects. fs-ops never throws (errors degrade to
  // empty/false), so this always responds ok with a result body.
  function handleFs(req: RpcRequest): void {
    const p = asRecord(req.params)
    const filePath = str(p.path) ?? ''
    const respond = (body: unknown): void => socket.respond(req.id, true, body)
    // Confine remote filesystem access to the shared project roots. A path outside them (or any
    // `../` traversal) is denied — degrade to the same empty/false shape fs-ops returns on error,
    // so the remote Explorer/Editor just sees "nothing there" rather than a thrown RPC.
    if (!isWithinRoots(filePath, getRoots())) {
      switch (req.method) {
        case 'fs.list':
          respond({ entries: [] })
          break
        case 'fs.readBinary':
          respond({ base64: '' })
          break
        case 'fs.write':
          respond({ ok: false })
          break
        default:
          respond({ content: '' })
      }
      return
    }
    switch (req.method) {
      case 'fs.list':
        void fs.listDir(filePath).then((entries) => respond({ entries }))
        break
      case 'fs.read':
        void fs.readText(filePath).then((content) => respond({ content }))
        break
      case 'fs.readBinary':
        void fs.readBinary(filePath).then((base64) => respond({ base64 }))
        break
      case 'fs.write':
        void fs.writeText(filePath, str(p.content) ?? '').then((ok) => respond({ ok }))
        break
    }
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
          // Reject: remote clients only ever attach to the host's existing tmux sessions
          // (`pty.attach`). `pty.create` would let a client spawn an arbitrary shell with a
          // client-chosen cwd — full remote command execution — so it is not served.
          socket.respond(req.id, false, { message: 'pty.create is not permitted for remote clients.' })
          break
        case 'pty.attach':
          handleAttach(req)
          break
        case 'pty.kill':
          handleKill(req)
          break
        case 'fs.list':
        case 'fs.read':
        case 'fs.readBinary':
        case 'fs.write':
          handleFs(req)
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
// Client → host: "re-send me the current canvas now." Covers the case where the client mirror
// mounts/subscribes after the host's initial connect-time push (no replay otherwise).
export const CANVAS_REQUEST_METHOD = 'canvas:request'

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

// The directories a remote client may touch over fs.* = the cwds of the host's shared canvas
// nodes (each terminal node carries its project cwd). Empty when nothing is shared yet ⇒
// deny-by-default. Subdirectories are allowed via the prefix check in isWithinRoots.
function rootsFromCanvas(canvas: CanvasState | null): string[] {
  if (!canvas) return []
  const roots = new Set<string>()
  for (const node of canvas.nodes) if (node.cwd) roots.add(node.cwd)
  return [...roots]
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
  // Connection-approval gate: a freshly-bridged client serves NO pty/fs RPCs or input frames
  // until the host human approves it (so a leaked offer cannot grant silent access). Reset on
  // every (re)connect and teardown.
  let approved = false
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
    approved = false
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
        // Bridge established with a client. Require explicit host approval before serving any
        // pty/fs RPC — surface the SAS so the human can verify + allow. Canvas state still pushes
        // (read-only mirror) so the client isn't staring at a blank screen while pending.
        approved = false
        send(IPC.remoteHostPeerPending, { sas: socket?.sas() ?? null })
        if (latestCanvas) canvasSync?.setState(latestCanvas)
      },
      onRpc: (req) => {
        // A client asking for a fresh canvas snapshot → re-push the current one (read-only).
        if (req.method === CANVAS_REQUEST_METHOD) {
          canvasSync?.broadcastCurrent()
          return
        }
        // Until the host approves this device, refuse every state-changing request: pty/fs RPCs
        // and client canvas mutations. (canvas:request above is the only allowed pre-approval op.)
        if (!approved) {
          if (req.id) socket?.respond(req.id, false, { message: 'Awaiting host approval.' })
          return
        }
        // Canvas mutations route to the canvas sync (which forwards them to the host renderer,
        // the single writer); everything else is a pty RPC.
        if (canvasSync?.handleRpc(req)) return
        handlers?.onRpc(req)
      },
      // Input/resize frames are dropped until approved (no keystrokes reach a host PTY).
      onFrame: (frame) => {
        if (approved) handlers?.onFrame(frame)
      },
      onClose: () => {
        // The client (or relay) dropped — kill served PTYs. relay-socket may reconnect; the
        // handlers stay bound to the same socket object across reconnects. Re-require approval.
        approved = false
        handlers?.closeAll()
      }
    })
    // Confine the client's fs.* access to the cwds of the host's currently-shared canvas nodes.
    handlers = createHostHandlers(ptyManager, socket, fsOps, () => rootsFromCanvas(latestCanvas))
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

  // Host human approved the pending device → start serving its pty/fs RPCs.
  ipcMain.on(IPC.remoteHostApprove, () => {
    if (socket) approved = true
  })
  // Host human rejected the device → drop the connection entirely.
  ipcMain.on(IPC.remoteHostReject, () => {
    teardown()
  })

  ipcMain.handle(IPC.remoteHostStop, () => {
    teardown()
  })
}
