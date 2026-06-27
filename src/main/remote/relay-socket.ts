// Relay socket + E2EE handshake + RPC/frame state machine (main process).
//
// A single connection to the dumb relay (`nodebaseserver/src/relay`). The relay
// forwards opaque bytes between a host and a client matched by a pairing token;
// it never decrypts. So the end-to-end-encrypted handshake and all traffic run
// HOST<->CLIENT *through* the relay — the relay is not a handshake participant.
//
// The handshake/RPC state machine, in brief:
//   - The token gates entry at the relay via a `?token=<token>` QUERY PARAM on
//     the wss URL (cross-task decision; matches the relay's index.ts). It is NOT
//     interleaved as a data frame — every frame on the wire is opaque peer
//     traffic.
//   - Handshake `e2ee_hello -> e2ee_ready -> e2ee_auth -> e2ee_authenticated`:
//       * client (knows the host pubkey) sends `e2ee_hello {publicKeyB64}` and
//         derives the shared key from the host pubkey;
//       * host learns the client pubkey from `e2ee_hello`, derives the same
//         shared key, replies `e2ee_ready`;
//       * client then sends an ENCRYPTED `e2ee_auth` (the relay already verified
//         the token and the offer pins the host pubkey, so for MVP a simple
//         authenticated marker is sufficient — no extra secret to prove);
//       * host replies an ENCRYPTED `e2ee_authenticated`. Both sides fire onReady
//         once their side of the auth exchange is complete.
//   - After authentication every peer message is an E2EE box (sent as binary).
//     The decrypted plaintext is tagged: 0x01 = JSON RPC envelope, 0x02 = a
//     binary terminal frame (framing.ts). Handshake control frames (`e2ee_hello`
//     / `e2ee_ready`) are sent as plaintext JSON strings so the receiver can tell
//     them apart from the encrypted binary boxes.
//
// Pure-ish: no IPC, no renderer. The WebSocket is INJECTED as a `RelayTransport`
// so tests drive two RelaySockets via in-process fakes with no real network;
// production passes a `ws` WebSocket wrapped via `wrapWebSocket`.

import { decrypt, deriveSharedKey, encrypt, publicKeyToB64, sasFromSharedKey, type KeyPair } from './e2ee'
import { decodeFrame, encodeFrame, type Frame, MAX_BINARY_BUFFERED_AMOUNT } from './framing'

// A minimal duplex transport. `send` accepts a string (handshake control) or a
// Uint8Array (encrypted box). `bufferedAmount` drives backpressure on frames.
export interface RelayTransport {
  readonly bufferedAmount: number
  send(data: string | Uint8Array): void
  close(): void
  onMessage(cb: (data: unknown) => void): void
  onClose(cb: () => void): void
}

// An RPC request envelope as seen by the peer's onRpc handler. `id` correlates a
// later `respond`.
export type RpcRequest = {
  id: string
  method: string
  params: unknown
}

export type RelaySocket = {
  // Send an RPC request to the peer; resolves with the peer's response body (or
  // rejects on a non-ok response / timeout / closed connection).
  rpc(method: string, params?: unknown): Promise<unknown>
  // Fire a one-way notification to the peer (no response expected, never rejects).
  // The peer receives it in `onRpc` with an empty `id` — answering it is a no-op
  // (notifications carry no correlation id). Returns false if not connected.
  notify(method: string, params?: unknown): boolean
  // Answer a received RPC request (from onRpc) by its id.
  respond(id: string, ok: boolean, body: unknown): void
  // Send a terminal frame to the peer. Returns false when the transport is over
  // its buffered-amount threshold (backpressure) or not connected.
  sendFrame(op: number, streamId: number, seq: number, payload: Uint8Array): boolean
  // The Short Authentication String for this channel (derived from the shared key), or null
  // before the handshake has derived a key. Both peers compute the same value.
  sas(): string | null
  // Tear down: stops reconnects and closes the transport.
  close(): void
}

export type ConnectRelayOptions = {
  // The relay wss URL. `?token=` is appended automatically when opening a socket.
  url: string
  // Single-use pairing token; gates entry at the relay (query param).
  token: string
  role: 'host' | 'client'
  // Our long-lived (host) or ephemeral (client) NaCl keypair.
  ourKeys: KeyPair
  // The peer's public key, base64. REQUIRED for the client (it must know the
  // host's pubkey up front); for the host it is learned from `e2ee_hello`.
  theirPubB64?: string
  // Injected transport. Tests pass an in-process fake; production passes a `ws`
  // WebSocket wrapped via `wrapWebSocket`. When omitted, a `ws` socket is opened
  // from `url` (production default).
  transport?: RelayTransport
  onReady(): void
  onRpc(msg: RpcRequest): void
  onFrame(f: Frame): void
  onClose(): void
}

// Plaintext-tag bytes for decrypted peer payloads.
const TAG_RPC = 0x01
const TAG_FRAME = 0x02

const RPC_TIMEOUT_MS = 30_000
const KEEPALIVE_INTERVAL_MS = 25_000
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000]

type RpcEnvelope =
  | { kind: 'req'; id: string; method: string; params: unknown }
  | { kind: 'notify'; method: string; params: unknown }
  | { kind: 'res'; id: string; ok: boolean; body: unknown }
  | { kind: 'keepalive' }

type HandshakeControl =
  | { type: 'e2ee_hello'; publicKeyB64: string }
  | { type: 'e2ee_ready' }

type State = 'connecting' | 'handshaking' | 'ready' | 'closed'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function connectRelay(opts: ConnectRelayOptions): RelaySocket {
  if (opts.role === 'client' && !opts.theirPubB64) {
    throw new Error('connectRelay: client role requires theirPubB64 (the host public key)')
  }

  let transport: RelayTransport | null = null
  let sharedKey: Uint8Array | null = null
  let state: State = 'connecting'
  let intentionallyClosed = false
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  let requestCounter = 0
  let readyFired = false
  // Replay/reorder protection: every encrypted message carries a strictly-increasing per-
  // direction counter inside the authenticated plaintext. The receiver rejects any message whose
  // counter is not greater than the last accepted one, so a relay (or on-path attacker) cannot
  // replay a captured box (e.g. re-injecting an OP.Input keystroke frame or a pty.kill RPC) nor
  // reorder traffic. Counters reset per (re)connection — a fresh handshake is a fresh stream.
  let sendSeq = 0
  let recvSeq = -1

  const pending = new Map<
    string,
    { resolve: (body: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()

  function buildUrl(): string {
    // Append `?token=` so the relay can read the pairing token from the query
    // string (cross-task decision). Preserve any existing query.
    const sep = opts.url.includes('?') ? '&' : '?'
    return `${opts.url}${sep}token=${encodeURIComponent(opts.token)}`
  }

  function openConnection(): void {
    if (intentionallyClosed) {
      return
    }
    state = 'connecting'
    sharedKey = null
    readyFired = false
    sendSeq = 0
    recvSeq = -1

    if (opts.transport) {
      // Injected transport (tests). It is already "open"; treat that as the
      // open event. A re-open after a drop is not supported for injected
      // transports — production reconnect goes through the real ws path.
      transport = opts.transport
    } else {
      transport = openWebSocketTransport(buildUrl())
    }

    transport.onMessage((data) => handleMessage(data))
    transport.onClose(() => handleClose())

    state = 'handshaking'
    if (opts.role === 'client') {
      // Client knows the host pubkey: derive now and greet.
      sharedKey = deriveSharedKey(opts.theirPubB64!, opts.ourKeys.secretKey)
      sendControl({ type: 'e2ee_hello', publicKeyB64: publicKeyToB64(opts.ourKeys.publicKey) })
    }
    // Host waits passively for `e2ee_hello` to learn the client pubkey.
  }

  function sendControl(control: HandshakeControl): void {
    transport?.send(JSON.stringify(control))
  }

  // Prepend the outbound monotonic counter (8 bytes LE) to the plaintext before sealing, so the
  // peer can reject replays/reorders. Mirrors framing.ts's 64-bit split to stay within safe ints.
  const SEQ_BYTES = 8
  function withSeq(plaintext: Uint8Array): Uint8Array {
    const seq = sendSeq++
    const out = new Uint8Array(SEQ_BYTES + plaintext.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, Math.floor(seq / 0x100000000), true)
    view.setUint32(4, seq >>> 0, true)
    out.set(plaintext, SEQ_BYTES)
    return out
  }

  function sendEncrypted(plaintext: Uint8Array): boolean {
    if (!transport || !sharedKey || state !== 'ready') {
      return false
    }
    transport.send(encrypt(withSeq(plaintext), sharedKey))
    return true
  }

  // During the handshake the auth control frames must be sent before `state`
  // flips to 'ready', so this variant does not gate on state.
  function sendEncryptedHandshake(plaintext: Uint8Array): void {
    if (!transport || !sharedKey) {
      return
    }
    transport.send(encrypt(withSeq(plaintext), sharedKey))
  }

  function tagged(tag: number, body: Uint8Array): Uint8Array {
    const out = new Uint8Array(body.length + 1)
    out[0] = tag
    out.set(body, 1)
    return out
  }

  function fireReadyOnce(): void {
    if (readyFired) {
      return
    }
    readyFired = true
    reconnectAttempt = 0
    startKeepalive()
    opts.onReady()
  }

  function handleMessage(data: unknown): void {
    if (state === 'closed') {
      return
    }

    const asString = stringFromData(data)
    if (asString !== null) {
      // Plaintext JSON => a handshake control frame.
      handleControl(asString)
      return
    }

    const bytes = bytesFromData(data)
    if (!bytes) {
      return
    }

    // Everything binary is an E2EE box.
    if (!sharedKey) {
      return
    }
    const sealed = decrypt(bytes, sharedKey)
    if (!sealed || sealed.length < SEQ_BYTES) {
      return
    }
    // Enforce the strictly-increasing per-direction counter inside the authenticated plaintext.
    // A non-increasing counter means a replayed or reordered box — drop it.
    const seqView = new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength)
    const seq = seqView.getUint32(0, true) * 0x100000000 + seqView.getUint32(4, true)
    if (seq <= recvSeq) {
      return
    }
    recvSeq = seq
    const plain = sealed.subarray(SEQ_BYTES)

    if (state === 'handshaking') {
      handleHandshakeEncrypted(plain)
      return
    }
    if (state !== 'ready') {
      return
    }
    handlePeerPlaintext(plain)
  }

  function handleControl(raw: string): void {
    let control: HandshakeControl
    try {
      control = JSON.parse(raw) as HandshakeControl
    } catch {
      return
    }
    if (control.type === 'e2ee_hello' && opts.role === 'host') {
      // Host learns the client pubkey, derives the shared key, replies ready.
      if (typeof control.publicKeyB64 !== 'string') {
        return
      }
      sharedKey = deriveSharedKey(control.publicKeyB64, opts.ourKeys.secretKey)
      sendControl({ type: 'e2ee_ready' })
      return
    }
    if (control.type === 'e2ee_ready' && opts.role === 'client') {
      // Client proves the pairing with an encrypted auth marker. The relay
      // already verified the token and the offer pins the host pubkey, so a
      // simple marker is sufficient for MVP.
      sendEncryptedHandshake(tagged(TAG_RPC, textEncoder.encode(JSON.stringify({ type: 'e2ee_auth' }))))
    }
  }

  function handleHandshakeEncrypted(plain: Uint8Array): void {
    // Tag byte distinguishes control vs payload; during handshake we only expect
    // control JSON (auth / authenticated).
    if (plain.length < 1 || plain[0] !== TAG_RPC) {
      return
    }
    let msg: { type?: string }
    try {
      msg = JSON.parse(textDecoder.decode(plain.subarray(1))) as { type?: string }
    } catch {
      return
    }
    if (msg.type === 'e2ee_auth' && opts.role === 'host') {
      // Host accepts the client's authenticated marker, confirms, becomes ready.
      sendEncryptedHandshake(
        tagged(TAG_RPC, textEncoder.encode(JSON.stringify({ type: 'e2ee_authenticated' })))
      )
      state = 'ready'
      fireReadyOnce()
      return
    }
    if (msg.type === 'e2ee_authenticated' && opts.role === 'client') {
      state = 'ready'
      fireReadyOnce()
    }
  }

  function handlePeerPlaintext(plain: Uint8Array): void {
    if (plain.length < 1) {
      return
    }
    const tag = plain[0]
    const body = plain.subarray(1)
    if (tag === TAG_FRAME) {
      const frame = decodeFrame(body)
      if (frame) {
        opts.onFrame(frame)
      }
      return
    }
    if (tag !== TAG_RPC) {
      return
    }
    let env: RpcEnvelope
    try {
      env = JSON.parse(textDecoder.decode(body)) as RpcEnvelope
    } catch {
      return
    }
    if (env.kind === 'keepalive') {
      return
    }
    if (env.kind === 'req') {
      opts.onRpc({ id: env.id, method: env.method, params: env.params })
      return
    }
    if (env.kind === 'notify') {
      // One-way notification: surface it like an RPC but with an empty id, so a
      // `respond` (if any) is a no-op (no matching pending request on our side).
      opts.onRpc({ id: '', method: env.method, params: env.params })
      return
    }
    if (env.kind === 'res') {
      const waiter = pending.get(env.id)
      if (!waiter) {
        return
      }
      pending.delete(env.id)
      clearTimeout(waiter.timer)
      if (env.ok) {
        waiter.resolve(env.body)
      } else {
        waiter.reject(new Error(rpcErrorMessage(env.body)))
      }
    }
  }

  function startKeepalive(): void {
    stopKeepalive()
    keepaliveTimer = setInterval(() => {
      sendEncrypted(tagged(TAG_RPC, textEncoder.encode(JSON.stringify({ kind: 'keepalive' }))))
    }, KEEPALIVE_INTERVAL_MS)
    // Don't keep the event loop alive purely for keepalives.
    keepaliveTimer.unref?.()
  }

  function stopKeepalive(): void {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
  }

  function handleClose(): void {
    stopKeepalive()
    transport = null
    sharedKey = null
    const wasReady = state === 'ready'
    rejectAllPending('Relay connection closed.')
    if (intentionallyClosed) {
      state = 'closed'
      return
    }
    state = 'closed'
    opts.onClose()
    // Reconnect only applies to the production ws path; injected transports are
    // single-shot (the test fake cannot re-open).
    if (!opts.transport && wasReady) {
      scheduleReconnect()
    }
  }

  // KNOWN MVP LIMITATION: this reconnect path re-dials with the *same* pairing token, which
  // the real relay permanently rejects (the token is single-use and consumed on first pair,
  // with a ~600s TTL). So a post-drop reconnect can never re-authenticate against the live
  // relay — a working reconnect would need a freshly minted token, which is out of MVP scope.
  // The machinery is kept (it's harmless and useful once token re-minting exists); don't be
  // misled into thinking dropped connections currently recover on their own.
  function scheduleReconnect(): void {
    if (reconnectTimer || intentionallyClosed) {
      return
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      openConnection()
    }, delay)
    reconnectTimer.unref?.()
  }

  function rejectAllPending(reason: string): void {
    const err = new Error(reason)
    for (const [id, waiter] of pending) {
      pending.delete(id)
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
  }

  function nextId(): string {
    requestCounter += 1
    return `${opts.role}-rpc-${requestCounter}-${Date.now()}`
  }

  openConnection()

  return {
    rpc(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId()
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`RPC timed out: ${method}`))
        }, RPC_TIMEOUT_MS)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
        const sent = sendEncrypted(
          tagged(TAG_RPC, textEncoder.encode(JSON.stringify({ kind: 'req', id, method, params })))
        )
        if (!sent) {
          pending.delete(id)
          clearTimeout(timer)
          reject(new Error('Relay socket is not connected.'))
        }
      })
    },
    notify(method, params) {
      return sendEncrypted(
        tagged(TAG_RPC, textEncoder.encode(JSON.stringify({ kind: 'notify', method, params })))
      )
    },
    respond(id, ok, body) {
      sendEncrypted(tagged(TAG_RPC, textEncoder.encode(JSON.stringify({ kind: 'res', id, ok, body }))))
    },
    sendFrame(op, streamId, seq, payload) {
      if (!transport || state !== 'ready') {
        return false
      }
      if (transport.bufferedAmount > MAX_BINARY_BUFFERED_AMOUNT) {
        return false
      }
      return sendEncrypted(tagged(TAG_FRAME, encodeFrame(op, streamId, seq, payload)))
    },
    sas() {
      return sharedKey ? sasFromSharedKey(sharedKey) : null
    },
    close() {
      intentionallyClosed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      stopKeepalive()
      rejectAllPending('Relay socket closed.')
      state = 'closed'
      transport?.close()
      transport = null
      sharedKey = null
    }
  }
}

function rpcErrorMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const maybe = body as { message?: unknown; error?: unknown }
    if (typeof maybe.message === 'string') {
      return maybe.message
    }
    if (typeof maybe.error === 'string') {
      return maybe.error
    }
  }
  return 'RPC failed.'
}

// --- transport payload coercion ---------------------------------------------

function stringFromData(data: unknown): string | null {
  if (typeof data === 'string') {
    return data
  }
  return null
}

function bytesFromData(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  // `ws` may deliver a Node Buffer (which is a Uint8Array) or an array of
  // Buffers when fragmented; handle the array case defensively.
  if (Array.isArray(data) && data.every((d) => d instanceof Uint8Array)) {
    const total = data.reduce((n, d) => n + (d as Uint8Array).length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const d of data as Uint8Array[]) {
      out.set(d, offset)
      offset += d.length
    }
    return out
  }
  return null
}

// --- production ws wrapper ----------------------------------------------------

// Wrap a connected `ws` WebSocket as a RelayTransport. Kept here so the host
// (Task 6) and client (Task 7) share one ws adapter. Imported lazily so the
// pure module + its tests never load `ws`.
export function wrapWebSocket(ws: import('ws').WebSocket): RelayTransport {
  ws.binaryType = 'nodebuffer'
  return {
    get bufferedAmount() {
      return ws.bufferedAmount
    },
    // Strings (handshake control) go out as ws *text* frames; Uint8Array (E2EE boxes) as ws
    // *binary*. The relay preserves that text/binary-ness end to end.
    send: (data) => ws.send(data, { binary: typeof data !== 'string' }),
    close: () => ws.close(),
    // Deliver ws *text* frames as JS strings and *binary* frames as bytes, so relay-socket's
    // type-based control-vs-box discrimination works. (`ws` hands us a Buffer for both unless we
    // consult `isBinary`.)
    onMessage: (cb) =>
      ws.on('message', (data: Buffer, isBinary: boolean) =>
        cb(isBinary ? data : data.toString('utf-8'))
      ),
    onClose: (cb) => ws.on('close', () => cb())
  }
}

// Open a `ws` WebSocket to `url` and return it wrapped. Sends start only once
// the socket is open; messages before open are dropped (the handshake retries on
// reconnect). Used as the production default when no transport is injected.
function openWebSocketTransport(url: string): RelayTransport {
  // Lazy require so test/pure consumers don't pull in the native-ish dep.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WS = require('ws') as typeof import('ws')
  const ws = new WS.WebSocket(url)
  ws.binaryType = 'nodebuffer'
  const wrapped = wrapWebSocket(ws)
  // Buffer sends issued before 'open'.
  const queue: (string | Uint8Array)[] = []
  let open = false
  ws.on('open', () => {
    open = true
    for (const item of queue.splice(0)) {
      ws.send(item)
    }
  })
  return {
    get bufferedAmount() {
      return ws.bufferedAmount
    },
    send: (data) => {
      if (open) {
        ws.send(data)
      } else {
        queue.push(data)
      }
    },
    close: () => ws.close(),
    onMessage: wrapped.onMessage,
    onClose: wrapped.onClose
  }
}
