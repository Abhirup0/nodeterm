// Client service — drive a remote host's PTYs over the relay (main process).
//
// The mirror image of `host-service.ts`. When the user pastes a host's pairing OFFER,
// the app: (1) gates on a valid Pro entitlement (+ the dev gate), (2) decodes the offer,
// (3) connects to the relay as the CLIENT (which triggers the host<->client bridge), and
// (4) returns a `connectionId` the renderer's RemoteTransport addresses.
//
// While connected, the client maps the renderer's TerminalTransport calls onto E2EE
// RPC/frames the host understands (the wire contract is host-service.ts's mirror):
//   - `create {cols, rows, cwd?, shell?, persistKey?, agentId?}` -> RPC `pty.create`,
//     resolving with the host's `{ streamId }` (used as the renderer-facing sessionId).
//   - `write(streamId, data)`        -> `OP.Input`  frame (payload = UTF-8 bytes)
//   - `resize(streamId, cols, rows)` -> `OP.Resize` frame (payload = 2x uint16 LE)
//   - `kill(streamId)`               -> RPC `pty.kill {streamId}`
//   - host `OP.Output` frame -> per-session data event (UTF-8 decoded)
//   - host `OP.Error`  frame -> per-session exit event ({exitCode} JSON), stream dropped
//
// This file is glue over already-tested units (relay-socket, framing, pairing, e2ee). The
// pure call->RPC/frame mapping lives in `createClientHandlers` so it is unit-testable with
// fakes; `initRemoteClient` wires it to IPC, the license gate, and the relay socket.

import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import type { CanvasMutation, CanvasState, DirEntry, PtyCreateOptions } from '../../shared/types'
import { genKeyPair } from './e2ee'
import { OP, type Frame } from './framing'
import { CANVAS_MUTATE_METHOD, CANVAS_REQUEST_METHOD, CANVAS_STATE_METHOD } from './host-service'
import { decodeOffer } from './pairing'
import { connectRelay, type RelaySocket, type RpcRequest } from './relay-socket'
import { createSnapshotReassembler, type SnapshotReassembler } from './snapshot'

// Default relay endpoint override gate — mirrors host-service.ts. Used only for the dev gate;
// the actual endpoint a client connects to comes from the decoded offer.
const DEV_RELAY_OVERRIDE = process.env.NODETERM_RELAY_URL

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// --- pure client handlers (TerminalTransport calls <-> RPC/frames) -----------

// The slice of RelaySocket the client needs to drive the host.
export interface ClientRelaySocket {
  rpc(method: string, params?: unknown): Promise<unknown>
  sendFrame(op: number, streamId: number, seq: number, payload: Uint8Array): boolean
}

// Sinks the client raises for a stream's output/exit (the IPC layer forwards these to the
// renderer over per-session events). Pure handlers stay free of Electron.
export interface ClientSessionSinks {
  onData(streamId: number, data: string): void
  onExit(streamId: number, exitCode: number): void
}

export interface ClientHandlers {
  /** Open a remote PTY. Resolves with the host's streamId (the renderer-facing sessionId). */
  create(options: PtyCreateOptions): Promise<number>
  /** Send input bytes to a remote PTY. */
  write(streamId: number, data: string): void
  /** Resize a remote PTY (cols, rows). */
  resize(streamId: number, cols: number, rows: number): void
  /** Kill a remote PTY (the host detaches its client; the host-side tmux session survives). */
  kill(streamId: number): void
  /** Route an inbound host frame (OP.Output / OP.Error) to the matching session sinks. */
  onFrame(frame: Frame): void
  /** Drop all tracked streams (called on disconnect/close); does not RPC the host. */
  closeAll(): void
  /** List a directory on the host's filesystem (over `fs.list` RPC). */
  fsList(path: string): Promise<DirEntry[]>
  /** Read a host file's UTF-8 text (over `fs.read` RPC). */
  fsRead(path: string): Promise<string>
  /** Read a host file as base64 (over `fs.readBinary` RPC). */
  fsReadBinary(path: string): Promise<string>
  /** Write UTF-8 text to a host file (over `fs.write` RPC). */
  fsWrite(path: string, content: string): Promise<boolean>
}

interface Stream {
  /** Outbound OP.Input/OP.Resize sequence counter. */
  seq: number
  /** Reassembles the host's SnapshotStart→Chunk*→End into the initial screen text. */
  snapshot: SnapshotReassembler
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/**
 * Build the call->RPC/frame router that drives a remote host's PTYs. Pure over its two
 * injected dependencies (a relay socket + the session sinks) so it can be unit-tested with
 * fakes — no sockets, no Electron.
 */
export function createClientHandlers(
  socket: ClientRelaySocket,
  sinks: ClientSessionSinks
): ClientHandlers {
  const streams = new Map<number, Stream>()

  function resizePayload(cols: number, rows: number): Uint8Array {
    const buf = new Uint8Array(4)
    const view = new DataView(buf.buffer)
    view.setUint16(0, Math.max(1, Math.min(0xffff, Math.floor(cols))), true)
    view.setUint16(2, Math.max(1, Math.min(0xffff, Math.floor(rows))), true)
    return buf
  }

  return {
    async create(options) {
      // RemoteTransport is only ever used for mirrored (remote) nodes, so `create` maps to
      // `pty.attach` — the client attaches to the host's EXISTING tmux session for this node id
      // (the persistKey is the host node id from the mirror) and gets a snapshot of the current
      // screen before live output, instead of spawning a fresh blank PTY (B4's blank-terminal bug).
      const body = asRecord(
        await socket.rpc('pty.attach', {
          nodeId: options.persistKey,
          cols: options.cols,
          rows: options.rows
        })
      )
      const streamId = body.streamId
      if (typeof streamId !== 'number' || !Number.isFinite(streamId)) {
        throw new Error('Host did not return a streamId.')
      }
      streams.set(streamId, { seq: 0, snapshot: createSnapshotReassembler() })
      return streamId
    },
    write(streamId, data) {
      const stream = streams.get(streamId)
      if (!stream) return
      socket.sendFrame(OP.Input, streamId, stream.seq++, textEncoder.encode(data))
    },
    resize(streamId, cols, rows) {
      const stream = streams.get(streamId)
      if (!stream) return
      socket.sendFrame(OP.Resize, streamId, stream.seq++, resizePayload(cols, rows))
    },
    kill(streamId) {
      if (!streams.has(streamId)) return
      streams.delete(streamId)
      // Best-effort; the host forgets the stream regardless of our knowing the outcome.
      void socket.rpc('pty.kill', { streamId }).catch(() => {})
    },
    onFrame(frame) {
      const stream = streams.get(frame.streamId)
      if (!stream) return
      if (
        frame.op === OP.SnapshotStart ||
        frame.op === OP.SnapshotChunk ||
        frame.op === OP.SnapshotEnd
      ) {
        // Buffer the snapshot; on End deliver the reassembled current screen as the FIRST onData
        // so the mirrored xterm paints it before any live output arrives.
        const res = stream.snapshot.accept(frame)
        if (res.done && res.text) sinks.onData(frame.streamId, res.text)
        return
      }
      if (frame.op === OP.Output) {
        sinks.onData(frame.streamId, textDecoder.decode(frame.payload))
        return
      }
      if (frame.op === OP.Error) {
        // PTY exit: payload is {exitCode} JSON. Surface it, then forget the stream.
        let exitCode = 0
        try {
          const parsed = JSON.parse(textDecoder.decode(frame.payload)) as { exitCode?: unknown }
          if (typeof parsed.exitCode === 'number') exitCode = parsed.exitCode
        } catch {
          // Malformed exit payload — fall back to code 0.
        }
        streams.delete(frame.streamId)
        sinks.onExit(frame.streamId, exitCode)
      }
    },
    closeAll() {
      streams.clear()
    },
    async fsList(path) {
      const body = asRecord(await socket.rpc('fs.list', { path }))
      return Array.isArray(body.entries) ? (body.entries as DirEntry[]) : []
    },
    async fsRead(path) {
      const body = asRecord(await socket.rpc('fs.read', { path }))
      return typeof body.content === 'string' ? body.content : ''
    },
    async fsReadBinary(path) {
      const body = asRecord(await socket.rpc('fs.readBinary', { path }))
      return typeof body.base64 === 'string' ? body.base64 : ''
    },
    async fsWrite(path, content) {
      const body = asRecord(await socket.rpc('fs.write', { path, content }))
      return body.ok === true
    }
  }
}

// --- pure client canvas mirror router (relay <-> client renderer) ------------

// The slice of RelaySocket the client canvas router needs: a one-way client->host RPC for
// mutations. (Inbound host->client `canvas:state` arrives via `connectRelay.onRpc`, not here.)
export interface CanvasMutateSocket {
  rpc(method: string, params?: unknown): Promise<unknown>
}

export interface ClientCanvasRouter {
  /** Route an inbound host RPC/notify; returns the CanvasState when it is a `canvas:state` push. */
  handleRpc(req: RpcRequest): CanvasState | null
  /** Send the client's optimistic mutation to the host (best-effort; never throws). */
  sendMutation(mutation: CanvasMutation): void
}

/**
 * Build the client-side canvas mirror router. Pure over its single injected dependency (the relay
 * socket for client->host mutation RPC) so it is unit-testable with a fake — no Electron, no real
 * socket. The host's React Flow stays the single writer: the client renders the host's pushed
 * `canvas:state` (surfaced here from `handleRpc`) and sends back mutations the host applies, then
 * the next `canvas:state` reconciles.
 */
export function createClientCanvasRouter(socket: CanvasMutateSocket): ClientCanvasRouter {
  return {
    handleRpc(req) {
      if (req.method !== CANVAS_STATE_METHOD) return null
      const state = req.params as CanvasState
      if (!state || typeof state !== 'object' || !Array.isArray((state as { nodes?: unknown }).nodes)) {
        return null
      }
      return state
    },
    sendMutation(mutation) {
      // Best-effort: the host forgets the client's edit regardless of our knowing the outcome
      // (the next `canvas:state` is authoritative and reconciles any divergence).
      void socket.rpc(CANVAS_MUTATE_METHOD, mutation).catch(() => {})
    }
  }
}

// --- dev gate ----------------------------------------------------------------

// Never hit a real relay from an unpackaged build unless a relay is explicitly targeted
// (mirrors host-service.ts's `relayAllowed()`). Packaged builds are always allowed. We can't
// read `app.isPackaged` here without importing it — kept inline in `initRemoteClient`.

// --- IPC wiring --------------------------------------------------------------

interface ClientConnection {
  id: string
  socket: RelaySocket
  handlers: ClientHandlers
  canvas: ClientCanvasRouter
}

/**
 * Wire the client-mode IPC. `remote:client:connect` gates on the dev gate only (the host's Pro
 * mints the pairing token, so the client needs no entitlement), decodes the
 * offer, connects to the relay as the client (triggering the host bridge), and returns a
 * `connectionId`. The renderer's RemoteTransport(connectionId) then drives remote PTYs over
 * the per-session create/write/resize/kill IPC, with output/exit arriving on per-session
 * events (`remote:client:data:<connId>:<streamId>` / `...:exit:...`).
 */
export function initRemoteClient(win: BrowserWindow, deps?: { isPackaged?: boolean }): void {
  const connections = new Map<string, ClientConnection>()
  let counter = 0

  function send(channel: string, ...args: unknown[]): void {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  function relayAllowed(): boolean {
    return (deps?.isPackaged ?? true) || !!DEV_RELAY_OVERRIDE
  }

  ipcMain.handle(IPC.remoteClientConnect, async (_e, offerCode: string): Promise<string> => {
    // No Pro gate on the client: the paywall is the HOST minting the pairing token
    // (/v1/pair/token requires the host's entitlement). A valid offer is the credential, so a
    // user's free device can connect to their own Pro host. The dev/relay gate still applies.
    if (!relayAllowed()) {
      throw new Error('Remote access is unavailable in development builds (set NODETERM_RELAY_URL).')
    }
    const offer = decodeOffer(String(offerCode ?? ''))
    if (!offer) {
      throw new Error('That pairing code is invalid or incomplete.')
    }

    const connectionId = `remote-${++counter}`
    // Ephemeral keypair: a client identity is per-connection (the host pins its own long-lived
    // key in the offer; the client just needs a fresh keypair to derive the shared secret).
    const ourKeys = genKeyPair()

    // Bind handlers + canvas router lazily so their `onRpc` can reference the socket below.
    let handlers: ClientHandlers | null = null
    let canvas: ClientCanvasRouter | null = null

    const socket = connectRelay({
      url: offer.relayEndpoint,
      token: offer.pairingToken,
      role: 'client',
      ourKeys,
      theirPubB64: offer.hostPublicKeyB64,
      onReady: () => {
        // Bridge established. Surface the channel SAS so the client human can compare it with the
        // code the host shows before approving. Then ask the host to (re-)push its current canvas.
        send(IPC.remoteClientSas(connectionId), socket.sas())
        socket.notify(CANVAS_REQUEST_METHOD)
      },
      onRpc: (req) => {
        // The host pushes its canvas snapshot as a one-way `canvas:state` notify (id:''). Route it
        // to the client renderer's mirror; the host initiates no other RPC toward the client.
        const state = canvas?.handleRpc(req)
        if (state) send(IPC.remoteClientCanvasState(connectionId), state)
      },
      onFrame: (frame) => handlers?.onFrame(frame),
      onClose: () => {
        // Host/relay dropped — tell the renderer so it can tear down remote nodes.
        send(IPC.remoteClientClosed(connectionId))
      }
    })

    handlers = createClientHandlers(socket, {
      onData: (streamId, data) => send(IPC.remoteClientData(connectionId, streamId), data),
      onExit: (streamId, exitCode) => send(IPC.remoteClientExit(connectionId, streamId), exitCode)
    })
    canvas = createClientCanvasRouter(socket)

    connections.set(connectionId, { id: connectionId, socket, handlers, canvas })
    return connectionId
  })

  ipcMain.handle(IPC.remoteClientDisconnect, (_e, connectionId: string) => {
    const conn = connections.get(String(connectionId))
    if (!conn) return
    conn.handlers.closeAll()
    conn.socket.close()
    connections.delete(conn.id)
  })

  ipcMain.handle(
    IPC.remoteClientCreate,
    async (_e, connectionId: string, options: PtyCreateOptions): Promise<string> => {
      const conn = connections.get(String(connectionId))
      if (!conn) throw new Error('Remote connection is no longer available.')
      const streamId = await conn.handlers.create(options)
      return String(streamId)
    }
  )

  ipcMain.on(IPC.remoteClientWrite, (_e, connectionId: string, sessionId: string, data: string) => {
    connections.get(String(connectionId))?.handlers.write(Number(sessionId), data)
  })

  ipcMain.on(
    IPC.remoteClientResize,
    (_e, connectionId: string, sessionId: string, cols: number, rows: number) => {
      connections.get(String(connectionId))?.handlers.resize(Number(sessionId), cols, rows)
    }
  )

  ipcMain.on(IPC.remoteClientKill, (_e, connectionId: string, sessionId: string) => {
    connections.get(String(connectionId))?.handlers.kill(Number(sessionId))
  })

  // The client renderer's optimistic canvas edit → forward to the host as a `canvas:mutate` RPC.
  ipcMain.on(IPC.remoteClientMutate, (_e, connectionId: string, mutation: CanvasMutation) => {
    connections.get(String(connectionId))?.canvas.sendMutation(mutation)
  })

  // Remote filesystem: the client renderer's `remoteFs(connectionId)` proxies the local `fs:*`
  // shape onto the host's filesystem over the relay's `fs.*` RPCs. A missing connection degrades
  // to the same empty/false values the host's fs-ops would return on error.
  ipcMain.handle(IPC.remoteClientFsList, (_e, connectionId: string, path: string) =>
    connections.get(String(connectionId))?.handlers.fsList(path) ?? Promise.resolve([])
  )
  ipcMain.handle(IPC.remoteClientFsRead, (_e, connectionId: string, path: string) =>
    connections.get(String(connectionId))?.handlers.fsRead(path) ?? Promise.resolve('')
  )
  ipcMain.handle(IPC.remoteClientFsReadBinary, (_e, connectionId: string, path: string) =>
    connections.get(String(connectionId))?.handlers.fsReadBinary(path) ?? Promise.resolve('')
  )
  ipcMain.handle(
    IPC.remoteClientFsWrite,
    (_e, connectionId: string, path: string, content: string) =>
      connections.get(String(connectionId))?.handlers.fsWrite(path, content) ??
      Promise.resolve(false)
  )
}
