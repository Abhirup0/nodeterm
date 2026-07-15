// The interactive-host DRIVER (docs/remote-sessions.md 4c; Team Access, docs/superpowers/specs
// 2026-07-15-team-access-design.md): give the reviewed `connectRelayHost` machinery an IPC surface.
// `initRelayHost` is the Stage-4 twin of the legacy `initRemoteHost` (host-service.ts) — it runs
// BESIDE it (the phone still uses the old flow; that is deleted with the dialect in Task 10). It
// shares the same offer format and pairing-token mint, but everything a bridged peer does afterwards
// flows through `connectRelayHost` (→ `platform.dispatch`/`cast`), not the legacy phone RPC vocabulary.
//
// TEAM ACCESS — a POOL, not one listener. A paying host shares this Mac with up to `seats` devices
// (one seat per connected device). This module manages a POOL of independent `RelayHostSession`s;
// each seat still goes through the UNCHANGED per-session mutual-SAS + ConsentNotice gate in
// relay-host.ts. `relay:host:invite` (and the legacy `relay:host:start`) ADD a seat (cap-checked, no
// supersede); `relay:host:revoke` cuts ONE; `stop()` closes ALL.
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
// against THAT set — independent of the bookkeeping below. `relay:host:revoke` here uses the same cut.
import { randomUUID } from 'crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import type { ElectronPlatform } from '../platform-electron'
import { connectRelayHost, killRelayHostsByPeerKey, type RelayHostSession } from './relay-host'
import type { RelayTransport } from './relay-socket'
import { publicKeyToB64, type KeyPair } from './e2ee'
import { encodeOffer } from './pairing'
import { loadOrCreatePeerKeyPair } from './peer-identity'
import { isPremium as licenseIsPremium, getStoredEntitlement, licensedSeats as licenseSeats } from '../../core/license'
import { RELAY_URL, relayAllowed as hostRelayAllowed, mintPairingToken } from './host-service'
import { canAcceptSeat } from './seat-cap'

/** Thrown (as an Error message) when a new invite would exceed the licensed seat cap. The renderer
 *  maps it to "All seats in use — add a seat." Host-side/UX enforcement only (see below). */
export const E_SEATS_FULL = 'E_SEATS_FULL'

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
  /** The licensed seat cap (Team Access). Defaults to the real `licensedSeats()` (core/license.ts). */
  licensedSeats?: () => number
  /** TEST ONLY: override the wire-up (defaults to `connectRelayHost`). */
  connect?: typeof connectRelayHost
}

/** Metadata options for a new seat. `email` is a DISPLAY label only (never trust/identity — the SAS
 *  is the gate); it tags the pending/live seat in the Team Access list. */
export interface AddSeatOptions {
  projectId?: string
  email?: string
}

export interface RelayHost {
  /** Tear down EVERY listener / bridged peer in the pool (app quit). Idempotent. */
  stop(): void
}

/**
 * Wire the interactive relay-host IPC. `relay:host:invite` (and legacy `relay:host:start`) gate on
 * Pro + a free seat, mint a pairing token, open a NEW relay host listener via `connectRelayHost`, and
 * return the offer to hand to a peer — ADDING it to the pool (no supersede). `relay:host:confirm`
 * approves a pending peer; `relay:host:revoke` cuts one; `relay:host:stop` tears the whole pool down.
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
  const licensedSeats = deps.licensedSeats ?? licenseSeats

  // Renderer-facing token → the pending/live session it names. Populated once the peer is pending
  // (its SAS is known); the confirm/revoke/close paths resolve the session through it so a stray IPC
  // event can only ever act on the session it addresses. Mirrors initRemoteHost's `pendingApprovalId`.
  const byId = new Map<string, RelayHostSession>()
  // The POOL of minted listeners (Team Access): a session JOINS at mint and LEAVES on close. Its size
  // is the live+pending seat count the cap compares against `licensedSeats()`. The value holds the
  // invite `email` label (display only) that rides this seat's peer-pending/open events. Replaces the
  // old single `current` slot — a pool of N is the whole point of Team Access.
  const pool = new Map<RelayHostSession, { email?: string }>()

  function send(channel: string, ...args: unknown[]): void {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  function forget(session: RelayHostSession): void {
    for (const [id, s] of byId) if (s === session) byId.delete(id)
  }

  /**
   * Mint ONE pairing + open ONE relay host listener, ADDING it to the pool (no supersede). Cap-checked
   * against the licensed seats. Returns the offer to hand to the invited device.
   */
  async function addSeat({ projectId, email }: AddSeatOptions): Promise<{ offer: string }> {
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

    // SEAT CAP — count minted (pending + live) sessions in the pool. This is HOST-SIDE / UX
    // enforcement, NOT a server-guaranteed limit: a host that patched it out only cheats itself (it
    // is paying for the seats). Real, un-bypassable enforcement is v2, server-side (the relay refuses
    // the (seats+1)th bridge per account). Do NOT close others here — Team Access is ADDITIVE.
    if (!canAcceptSeat(pool.size, licensedSeats())) {
      throw new Error(E_SEATS_FULL)
    }

    // A locked keyring surfaces here as a rejected invite (PeerKeyLockedError / E_PEER_KEY_LOCKED):
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
      // The single project this hosting session shares with the peer. Absent → unscoped, as before.
      sharedProjectId: projectId,
      // The SAS is known — ask the human to compare it. NOTHING is served yet. The invite `email`
      // tags this seat in the renderer (display only).
      onPeerPending: (s) => {
        rendererId = randomUUID()
        byId.set(rendererId, s)
        send(IPC.relayHostPeerPending, {
          id: rendererId,
          sas: s.sas(),
          peerKeyB64: s.peerKeyB64() ?? '',
          email
        })
      },
      // Both humans confirmed: the peer is a live CorePlatform client now.
      onOpen: () => {
        if (rendererId) send(IPC.relayHostOpen, { id: rendererId, email })
      },
      // The relay socket dropped (the peer is already torn down when this fires). Free the seat.
      onClose: () => {
        forget(session)
        pool.delete(session)
        if (rendererId) send(IPC.relayHostClosed, { id: rendererId })
      }
    })
    // Join the pool immediately (before any peer connects) so the cap counts this seat from mint.
    pool.set(session, { email })

    return {
      offer: encodeOffer({
        relayEndpoint: url,
        pairingToken,
        hostPublicKeyB64: publicKeyToB64(keys.publicKey)
      })
    }
  }

  // Legacy entry point (RemoteAccessDialog / RemoteSection). Now ADDITIVE + cap-checked (no supersede)
  // — with cap 1 this is bit-for-bit today's single-peer behavior (a 2nd start is refused until the
  // first drops), and with cap N it adds a seat.
  ipcMain.handle(IPC.relayHostStart, (_e, projectId?: string): Promise<{ offer: string }> =>
    addSeat({ projectId })
  )

  // Team Access entry point (Settings → Team Access, Task 4): add a seat tagged with the invitee email.
  ipcMain.handle(
    IPC.relayHostInvite,
    (_e, opts: AddSeatOptions = {}): Promise<{ offer: string }> =>
      addSeat({ projectId: opts?.projectId, email: opts?.email })
  )

  // The human compared the SAS and pressed Confirm → advance the trust gate for THAT peer. Only the
  // session named by the id is touched; an unknown id (stale event) is a no-op.
  ipcMain.on(IPC.relayHostConfirm, (_e, msg: { id?: string } = {}) => {
    const session = msg?.id ? byId.get(msg.id) : undefined
    session?.confirm()
  })

  // Per-peer revoke (Team Access, closes the 4c follow-up): cut ONE bridged peer's LIVE socket
  // immediately and free its seat. Only the session named by the id is touched; an unknown/stale id is
  // a no-op.
  ipcMain.on(IPC.relayHostRevoke, (_e, msg: { id?: string } = {}) => {
    const session = msg?.id ? byId.get(msg.id) : undefined
    if (!session) return
    const peerKeyB64 = session.peerKeyB64()
    // Cut the live socket by peer IDENTITY — the same primitive index.ts's 4c revoker uses
    // (killRelayHostsByPeerKey, relay-host.ts). It closes every live session holding that key, which
    // is the right "remove this device" semantic. Host-side revoke + the seat cap above are UX/host
    // enforcement, NOT a server-guaranteed limit (v2 = server-side). On the desktop relay path a pin
    // never auto-admits (isPinned is phone-only), so cutting the socket already forces a fresh
    // SAS+consent re-pair — no separate unpin is needed to keep the removed device out.
    if (peerKeyB64) killRelayHostsByPeerKey(peerKeyB64)
    // killRelayHostsByPeerKey → session.close() does NOT fire our `onClose` (that runs only on a wire
    // drop, not a local close), so free the seat and notify the renderer here.
    forget(session)
    pool.delete(session)
    send(IPC.relayHostClosed, { id: msg.id })
  })

  const stop = (): void => {
    for (const session of pool.keys()) session.close()
    pool.clear()
    byId.clear()
  }

  ipcMain.handle(IPC.relayHostStop, () => {
    stop()
  })

  return { stop }
}
