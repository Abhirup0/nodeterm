// The interactive-host DRIVER (docs/remote-sessions.md 4c): give the reviewed `connectRelayHost`
// machinery an IPC surface. `initRelayHost` is the Stage-4 twin of the legacy `initRemoteHost`
// (host-service.ts) — it runs BESIDE it (the phone still uses the old flow; that is deleted with the
// dialect in Task 10). It shares the same offer format and pairing-token mint, but everything a
// bridged peer does afterwards flows through `connectRelayHost` (→ `platform.dispatch`/`cast`), not
// the legacy phone RPC vocabulary.
//
// SECURITY — nothing is served before MUTUAL approval. This file only FORWARDS the reviewed gate:
//   - `onPeerPending` (the E2EE handshake completed, the SAS is known) → send `relay:host:peer-pending`
//     to the renderer and WAIT. The peer is NOT a client yet: connectRelayHost registers no sink and
//     joins no presence until its trust gate's `onOpen` fires (BOTH humans confirmed the same SAS).
//   - the human's `relay:host:confirm` → `session.confirm()` (the ONLY local-confirm call site).
//   - `onOpen` (mutual) → `relay:host:open`; `onClose` (socket gone) → `relay:host:closed`.
// This module never dispatches peer traffic, never registers a sink, never touches a handler — it
// cannot serve a peer early even by accident, because it holds none of the machinery that serves.
//
// REVOCATION reaches sessions started here for free: `connectRelayHost` adds every session to its own
// module-level `live` set, and index.ts's revoker calls `killRelayHostsByPeerKey` (relay-host.ts)
// against THAT set — independent of the bookkeeping below.
import { randomUUID } from 'crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import type { ElectronPlatform } from '../platform-electron'
import { connectRelayHost, type RelayHostSession } from './relay-host'
import type { RelayTransport } from './relay-socket'
import { publicKeyToB64, type KeyPair } from './e2ee'
import { encodeOffer } from './pairing'
import { loadOrCreatePeerKeyPair } from './peer-identity'
import { isPremium as licenseIsPremium, getStoredEntitlement } from '../../core/license'
import { RELAY_URL, relayAllowed as hostRelayAllowed, mintPairingToken } from './host-service'

/** Injectable seams — production defaults hit the real license gate / API / OS keyring; tests pass
 *  an in-process transport, a fake mint, and a fixed keypair so nothing touches the network. */
export interface RelayHostDeps {
  /** Relay wss URL (defaults to RELAY_URL). */
  url?: string
  /** TEST ONLY: an in-process RelayTransport forwarded into `connectRelayHost`. */
  transport?: RelayTransport
  /** The long-lived peer identity this desktop presents (defaults to loadOrCreatePeerKeyPair). */
  loadKeys?: () => Promise<KeyPair>
  /** Mint the single-use pairing token (defaults to the shared `mintPairingToken`). */
  mintToken?: (entitlement: string) => Promise<{ pairingToken: string }>
  isPremium?: () => boolean
  relayAllowed?: () => boolean
  getEntitlement?: () => string | null
  /** TEST ONLY: override the wire-up (defaults to `connectRelayHost`). */
  connect?: typeof connectRelayHost
}

export interface RelayHost {
  /** Tear down the current listener / bridged peer (app quit). Idempotent. */
  stop(): void
}

/**
 * Wire the interactive relay-host IPC. `relay:host:start` gates on Pro, mints a pairing token,
 * opens a relay host listener via `connectRelayHost`, and returns the offer to hand to a peer.
 * `relay:host:confirm` approves the pending peer; `relay:host:stop` tears the listener down.
 */
export function initRelayHost(
  win: BrowserWindow,
  platform: ElectronPlatform,
  deps: RelayHostDeps = {}
): RelayHost {
  const url = deps.url ?? RELAY_URL
  const connect = deps.connect ?? connectRelayHost
  const loadKeys = deps.loadKeys ?? loadOrCreatePeerKeyPair
  const mintToken = deps.mintToken ?? mintPairingToken
  const isPremium = deps.isPremium ?? licenseIsPremium
  const relayAllowed = deps.relayAllowed ?? hostRelayAllowed
  const getEntitlement = deps.getEntitlement ?? getStoredEntitlement

  // Renderer-facing token → the pending/live session it names. Populated once the peer is pending
  // (its SAS is known); the confirm/close paths resolve the session through it so a stray IPC event
  // can only ever act on the session it addresses. Mirrors initRemoteHost's `pendingApprovalId`.
  const byId = new Map<string, RelayHostSession>()
  // The current listener. A fresh `start()` supersedes it (like initRemoteHost's single `session`),
  // and `stop()` closes it — both idempotent via `RelayHostSession.close()`.
  let current: RelayHostSession | null = null

  function send(channel: string, ...args: unknown[]): void {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  function forget(session: RelayHostSession): void {
    for (const [id, s] of byId) if (s === session) byId.delete(id)
  }

  ipcMain.handle(IPC.relayHostStart, async (_e, projectId?: string): Promise<{ offer: string }> => {
    if (!isPremium()) {
      throw new Error('Remote access requires nodeterm Pro.')
    }
    if (!relayAllowed()) {
      throw new Error('Remote access is unavailable in development builds (set NODETERM_RELAY_URL).')
    }
    const entitlement = getEntitlement()
    if (!entitlement) {
      throw new Error('No entitlement found — please re-activate nodeterm Pro.')
    }

    // Supersede any existing listener before opening a fresh one (single-listener, like the legacy
    // interactive host). close() is idempotent, so an already-dropped one is a no-op.
    current?.close()
    current = null

    // A locked keyring surfaces here as a rejected start() (PeerKeyLockedError / E_PEER_KEY_LOCKED):
    // the identity on disk is intact and must not be rotated — the renderer tells the human to unlock.
    const keys = await loadKeys()
    const { pairingToken } = await mintToken(entitlement)

    // The renderer token for THIS listener's eventual peer. Minted when the peer becomes pending, so
    // onOpen/onClose reference the same id the peer-pending event carried.
    let rendererId: string | null = null

    const session = connect({
      url,
      token: pairingToken,
      ourKeys: keys,
      platform,
      transport: deps.transport,
      // The single project this hosting session shares with the peer (Task 2 scopes the
      // workspace:load response to it). Absent → unscoped, exactly as before.
      sharedProjectId: projectId,
      // The SAS is known — ask the human to compare it. NOTHING is served yet.
      onPeerPending: (s) => {
        rendererId = randomUUID()
        byId.set(rendererId, s)
        send(IPC.relayHostPeerPending, {
          id: rendererId,
          sas: s.sas(),
          peerKeyB64: s.peerKeyB64() ?? ''
        })
      },
      // Both humans confirmed: the peer is a live CorePlatform client now.
      onOpen: () => {
        if (rendererId) send(IPC.relayHostOpen, { id: rendererId })
      },
      // The relay socket dropped (the peer is already torn down when this fires).
      onClose: () => {
        forget(session)
        if (current === session) current = null
        if (rendererId) send(IPC.relayHostClosed, { id: rendererId })
      }
    })
    current = session

    return {
      offer: encodeOffer({
        relayEndpoint: url,
        pairingToken,
        hostPublicKeyB64: publicKeyToB64(keys.publicKey)
      })
    }
  })

  // The human compared the SAS and pressed Confirm → advance the trust gate for THAT peer. Only the
  // session named by the id is touched; an unknown id (stale event) is a no-op.
  ipcMain.on(IPC.relayHostConfirm, (_e, msg: { id?: string } = {}) => {
    const session = msg?.id ? byId.get(msg.id) : undefined
    session?.confirm()
  })

  const stop = (): void => {
    current?.close()
    current = null
    byId.clear()
  }

  ipcMain.handle(IPC.relayHostStop, () => {
    stop()
  })

  return { stop }
}
