// The interactive-client CONNECTOR (docs/remote-sessions.md 4c): the CLIENT half of the mutual-
// approval handshake, and the tunnel↔renderer frame pipe. It is the MIRROR IMAGE of
// `connectRelayHost` (relay-host.ts) — connect OUT to a host's pairing offer, run the same
// `createTrustGate` from the client side (compute + surface the SAS, confirm over the ENCRYPTED
// tunnel, receive the host's confirm the same way), and once BOTH humans have approved, expose the
// raw rpc.ts frame pipe so a later RpcClient (Task 4/5's FrameTransport + buildRelayApi) can drive
// the host's core over `relay:client:send` / `relay:client:frame`.
//
// SECURITY — the client's obligations are the symmetric image of the host's (see relay-host.ts and
// mutual-approval-core.ts). A mistake here forges the LOCAL human's consent or lets the relay open
// the session without the REMOTE human, either of which grants shell access on a machine:
//   - obligation (a): the ONLY thing that can advance approval is a trust frame that came out of the
//     E2EE box (`connectRelay`'s `onTunnel`). Our own confirm rides the SAME sealed channel via
//     `socket.sendTunnelText` inside the gate's `sendConfirm` — never a plaintext path. A plaintext
//     frame the relay injects dies in relay-socket's `handleControl` and never reaches the gate.
//   - obligation (b): EXACTLY ONE `MutualApproval`, bound to THIS session's host key. For a client
//     the pinned host key from the offer (`opts.hostKeyB64`) IS the socket's peer key
//     (`socket.peerPublicKeyB64()`) — it seeded the ECDH shared secret the SAS is derived from, and
//     the client role never re-derives it. `peerKeyIntact()` re-asserts it against the live socket on
//     every tunnel frame, so a mid-session re-key (which relay-socket already refuses) can never
//     advance approval, forward a frame, or open the pipe under a swapped key.
//
// This file BUILDS NO api: it produces the SAS/approval events and the raw frame pipe only. It never
// modifies the reviewed transport/trust/host machinery — it USES it.
import { connectRelay, type RelayTransport, type RelaySocket } from './relay-socket'
import { createTrustGate, type TrustGate } from './relay-trust'
import type { KeyPair } from './e2ee'
import { decodePtyData } from '../../shared/rpc'

export interface RelayClientSession {
  /** The 6-digit SAS both humans compare, or null before the key is derived. */
  sas(): string | null
  /** The host's stable box public key (base64) this session is bound to, or null before ready. */
  peerKeyB64(): string | null
  /** This human compared the SAS and pressed Confirm — sends our confirm over the ENCRYPTED tunnel. */
  confirm(): void
  /** Cast an outbound rpc.ts frame (JSON) at the host. Refused (returns false) before mutual approval:
   *  the host answers pre-approval reqs with E_UNAUTHORIZED anyway, so nothing is gained by sending. */
  send(json: string): boolean
  /** Both humans confirmed → the frame pipe is live. */
  isOpen(): boolean
  /** Tear down: close the relay socket. Idempotent. */
  close(): void
}

export interface ConnectRelayClientOptions {
  /** The relay wss URL from the decoded pairing offer. */
  url: string
  /** The single-use pairing token from the offer. */
  token: string
  /** The host's pinned box public key (base64) from the offer — the ECDH peer key for this session. */
  hostKeyB64: string
  /** Our long-lived peer identity (4d: pinned on both ends). Load via `loadOrCreatePeerKeyPair`. */
  ourKeys: KeyPair
  /** TEST ONLY: an in-process RelayTransport. Production opens a real ws (relay-socket.ts). */
  transport?: RelayTransport
  /** The SAS is known (the handshake completed) — ask this human to compare it. NOTHING is open yet. */
  onSas(session: RelayClientSession): void
  /** Mutually approved: the frame pipe is live (Task 4 builds the RpcClient on top). */
  onApproved(session: RelayClientSession): void
  /** An inbound rpc.ts TEXT frame from the host (a `res`/`ev`) → forward to the renderer. Trust frames
   *  are consumed by the gate BEFORE this and never delivered here. */
  onFrame(json: string): void
  /** An inbound pty:data BINARY frame → forward as pty output (mirrors the ws-bridge binary path). */
  onPtyData(sessionId: string, data: string): void
  /** The relay socket dropped (host/relay gone). */
  onClose(): void
}

export function connectRelayClient(opts: ConnectRelayClientOptions): RelayClientSession {
  // `socket` is assigned AFTER `connectRelay` returns, but over an in-process transport the client's
  // handshake (and thus `onReady`) completes SYNCHRONOUSLY during that call — so `onReady` must not
  // reach for `socket` (it uses `opts.hostKeyB64`, which IS the socket's peer key for a client), and
  // the deferred gate/session closures below guard with `socket?.`.
  let socket: RelaySocket | null = null
  let gate: TrustGate | null = null
  let opened = false
  let closed = false
  // OBLIGATION (b) — defence in depth. The host key this session is bound to (== socket peer key for a
  // client). If the socket's live peer key ever diverges from it, the session key was swapped under us;
  // we then refuse to advance approval, forward a frame, or open. relay-socket's layer-1 guard already
  // refuses the swap — this is the second, independent check.
  let sessionPeerKey: string | null = null
  let keySwapped = false

  const session: RelayClientSession = {
    sas: () => gate?.sas() ?? null,
    peerKeyB64: () => gate?.peerKeyB64() ?? null,
    confirm: () => gate?.confirmHere(),
    send: (json) => {
      if (!opened || closed || !socket) return false
      return socket.sendTunnelText(json)
    },
    isOpen: () => opened,
    close() {
      if (closed) return
      closed = true
      socket?.close()
    }
  }

  /** The socket's live peer key still matches the one bound into the gate. A false return means the
   *  session key was swapped under us — refuse everything and cut the session. */
  const peerKeyIntact = (): boolean => {
    if (keySwapped) return false
    if (sessionPeerKey !== null && socket?.peerPublicKeyB64() === sessionPeerKey) return true
    keySwapped = true
    session.close()
    return false
  }

  /** Both humans confirmed: the frame pipe is live. */
  const open = (): void => {
    if (closed || opened) return
    if (!peerKeyIntact()) return
    opened = true
    opts.onApproved(session)
  }

  socket = connectRelay({
    url: opts.url,
    token: opts.token,
    role: 'client',
    ourKeys: opts.ourKeys,
    theirPubB64: opts.hostKeyB64,
    transport: opts.transport,
    onReady: () => {
      // E2EE is up. This proves only that the host holds the pairing token — NOT that the human at the
      // other end is who we think. Build the trust gate and ask this human to compare the SAS; nothing
      // opens until BOTH confirm. Bind to the pinned host key (this session's ECDH peer key).
      if (gate) return
      sessionPeerKey = opts.hostKeyB64
      gate = createTrustGate({
        peerKeyB64: opts.hostKeyB64,
        sessionId: `${opts.hostKeyB64}:${Date.now()}`, // obligation (b): ONE state per pairing attempt
        sas: () => socket?.sas() ?? null,
        // The ONLY confirm we ever send — over the ENCRYPTED, session-keyed tunnel (obligation (a)).
        sendConfirm: (json) => {
          socket?.sendTunnelText(json)
        },
        onOpen: open
      })
      opts.onSas(session)
    },
    // The legacy phone dialect is not spoken here.
    onRpc: () => {},
    onFrame: () => {},
    onTunnel: (kind, payload) => {
      // OBLIGATION (b) — before advancing approval or forwarding a frame: the session key must still
      // belong to the ORIGINAL host. A frame that decrypted under a swapped key must not reach the gate
      // or the renderer.
      if (!peerKeyIntact()) return
      if (kind === 'binary') {
        // Binary is pty output only (mirrors the ws-bridge binary path). Anything undecodable is dropped.
        const decoded = decodePtyData(payload)
        if (decoded) opts.onPtyData(decoded.sessionId, decoded.data)
        return
      }
      const json = new TextDecoder().decode(payload)
      // Trust frames are consumed here and NEVER forwarded to the renderer's RPC client.
      if (gate?.onTunnelText(json)) return
      opts.onFrame(json)
    },
    onClose: () => {
      opts.onClose()
    }
  })

  return session
}
