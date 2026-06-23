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
import type { PtyCreateOptions } from '../../shared/types'
import { genKeyPair } from './e2ee'
import { OP, type Frame } from './framing'
import { decodeOffer } from './pairing'
import { connectRelay, type RelaySocket } from './relay-socket'

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
}

interface Stream {
  /** Outbound OP.Input/OP.Resize sequence counter. */
  seq: number
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
      const body = asRecord(await socket.rpc('pty.create', options))
      const streamId = body.streamId
      if (typeof streamId !== 'number' || !Number.isFinite(streamId)) {
        throw new Error('Host did not return a streamId.')
      }
      streams.set(streamId, { seq: 0 })
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
      if (!streams.has(frame.streamId)) return
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

    // Bind handlers lazily so they can reference the socket created just below.
    let handlers: ClientHandlers | null = null

    const socket = connectRelay({
      url: offer.relayEndpoint,
      token: offer.pairingToken,
      role: 'client',
      ourKeys,
      theirPubB64: offer.hostPublicKeyB64,
      onReady: () => {
        // Bridge established with the host. Handlers are already live; nothing extra to do.
      },
      onRpc: () => {
        // The host never initiates RPC toward the client in this MVP.
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

    connections.set(connectionId, { id: connectionId, socket, handlers })
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
}
