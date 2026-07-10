// Standing (always-on) phone host — the desktop side of the iOS relay-client "reach my Mac from
// anywhere" flow.
//
// When Settings → phoneAccessEnabled is on AND the device is Pro, this keeps a HOST relay
// connection registered under the host's stable id (base64url(sha256(hostPublicKey)).slice(0,22)),
// so a previously-paired phone can join over the relay at any time and attach to the host's tmux
// sessions after approval. Unlike the interactive host (a single-use offer you hand out), the
// standing host:
//   - mints its token from `POST /v1/relay/host-token` (role:'host', hostId as the broker room);
//   - AUTO-REFRESHES: relay tokens are short-lived (~120s TTL) and single-use, so we re-mint + a
//     reconnect before expiry, and reconnect with bounded backoff on socket close;
//   - uses PIN-ONCE approval: the first connect from a given phone (its box public key) prompts
//     the host human via the shared SAS dialog; on approval the pubkey is pinned, so later
//     connects auto-approve silently.
//
// The heavy lifting (relay wiring, RPC/frame handlers, fs jail, canvas mirror, approval gate) is
// shared with the interactive host via `connectHostSession`. Pin/lookup logic is the pure,
// unit-tested `approved-devices-core`.

import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import type { CanvasMutation, Settings } from '../../shared/types'
import { PtyManager } from '../../core/pty-manager'
import { getStoredEntitlement, isPremium } from '../../core/license'
import { publicKeyToB64 } from './e2ee'
import {
  API_BASE,
  RELAY_URL,
  connectHostSession,
  loadOrCreateKeyPair,
  relayAllowed,
  type HostSession
} from './host-service'
import { currentCanvas, initHostCanvasHub, subscribeCanvas } from './host-canvas-hub'
import { isPinned, pinDevice } from './approved-devices-core'
import { loadApprovedDevices, saveApprovedDevices } from './approved-devices'

// Re-mint the token this long before its expiry (TTL is ~120s). Floored so a bogus/short exp can't
// spin us.
const REFRESH_LEAD_MS = 30_000
const MIN_REFRESH_MS = 15_000
const DEFAULT_TTL_MS = 120_000
// Bounded backoff for reconnect after a socket close / mint failure.
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15_000]

interface HostTokenResponse {
  pairingToken: string
  hostId: string
  exp: number
}

/** Mint a standing host token from the API, proving Pro entitlement. Returns null on any failure. */
async function mintHostToken(
  entitlement: string,
  hostPublicKeyB64: string
): Promise<HostTokenResponse | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(`${API_BASE}/v1/relay/host-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entitlement, hostPublicKeyB64 }),
      signal: ctrl.signal
    })
    if (!res.ok) return null
    const json = (await res.json().catch(() => ({}))) as Partial<HostTokenResponse>
    if (!json.pairingToken) return null
    return { pairingToken: json.pairingToken, hostId: json.hostId ?? '', exp: json.exp ?? 0 }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface StandingHost {
  /** Explicit toggle (from the Settings switch). Reconciles the connection immediately. */
  setEnabled(enabled: boolean): void
  /** Read the desired state from settings (launch / external change) and reconcile. */
  syncFromSettings(): void
  /** Tear everything down (e.g. app quit). */
  stop(): void
}

/**
 * Wire the standing phone host. Idempotent to construct once; `setEnabled` / `syncFromSettings`
 * reconcile the live connection against (enabled && Pro && relay-allowed).
 */
export function initStandingHost(
  win: BrowserWindow,
  ptyManager: PtyManager,
  getSettings: () => Settings,
  listProjects: () => Promise<string> = async () => ''
): StandingHost {
  initHostCanvasHub()

  // Desired state (from the toggle / settings) and live state.
  let enabled = false
  let running = false
  let session: HostSession | null = null
  // A bridged-but-not-yet-approved peer awaiting the host human's decision (unpinned device).
  let pendingPeer: HostSession | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

  function send(channel: string, ...args: unknown[]): void {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  function clearTimers(): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function dropSession(): void {
    pendingPeer = null
    session?.close()
    session = null
  }

  function scheduleReconnect(): void {
    if (!running || reconnectTimer) return
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
    reconnectAttempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connectOnce()
    }, delay)
    reconnectTimer.unref?.()
  }

  function scheduleRefresh(exp: number): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    const untilExpMs = exp > 0 ? exp * 1000 - Date.now() : DEFAULT_TTL_MS
    const delay = Math.max(MIN_REFRESH_MS, untilExpMs - REFRESH_LEAD_MS)
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (!running) return
      // Don't cut an actively-approved phone mid-session for a token refresh — defer briefly and
      // re-check. When the relay eventually drops us at TTL, onClose reconnect takes over.
      if (session?.isApproved()) {
        scheduleRefresh(0) // re-arm ~DEFAULT_TTL_MS/… → MIN_REFRESH_MS later
        return
      }
      // Idle → re-mint with a fresh token by reconnecting.
      dropSession()
      void connectOnce()
    }, delay)
    refreshTimer.unref?.()
  }

  // A phone completed the E2EE handshake. Pinned device → auto-approve; else prompt the human.
  async function onPeerReady(s: HostSession): Promise<void> {
    const pub = s.peerPublicKeyB64()
    let store
    try {
      store = await loadApprovedDevices()
    } catch {
      store = { pubkeys: [] as string[] }
    }
    // The session may have been torn down while the disk read was in flight.
    if (s !== session) return
    if (pub && isPinned(store, pub)) {
      s.approve()
      return
    }
    // Unknown device → require the host human's approval (shared SAS dialog). Pin on approve.
    pendingPeer = s
    send(IPC.remoteHostPeerPending, { sas: s.sas() })
  }

  async function connectOnce(): Promise<void> {
    if (!running || session) return
    // Re-verify Pro on every (re)connect so a lapsed entitlement tears the standing host down.
    if (!isPremium()) {
      stop()
      return
    }
    const entitlement = getStoredEntitlement()
    if (!entitlement) {
      stop()
      return
    }
    const keys = await loadOrCreateKeyPair()
    const token = await mintHostToken(entitlement, publicKeyToB64(keys.publicKey))
    if (!running) return
    if (!token) {
      scheduleReconnect()
      return
    }
    reconnectAttempt = 0
    session = connectHostSession({
      url: RELAY_URL,
      token: token.pairingToken,
      ourKeys: keys,
      pty: ptyManager,
      getLatestCanvas: currentCanvas,
      subscribeCanvas,
      applyMutation: (mutation: CanvasMutation) => send(IPC.remoteHostApplyMutation, mutation),
      listProjects,
      onPeerReady: (s) => void onPeerReady(s),
      onClose: () => {
        // Peer/relay dropped. Fully reset this session and re-register (fresh token).
        pendingPeer = null
        session = null
        scheduleReconnect()
      }
    })
    scheduleRefresh(token.exp)
  }

  function start(): void {
    if (running) return
    running = true
    reconnectAttempt = 0
    void connectOnce()
  }

  function stop(): void {
    running = false
    clearTimers()
    dropSession()
  }

  function reconcile(): void {
    const want = enabled && isPremium() && relayAllowed()
    if (want && !running) start()
    else if (!want && running) stop()
  }

  // Host human approved / rejected the pending phone. These channels are shared with the
  // interactive host; guarding on our own `pendingPeer` keeps the two independent.
  ipcMain.on(IPC.remoteHostApprove, () => {
    const s = pendingPeer
    if (!s) return
    pendingPeer = null
    const pub = s.peerPublicKeyB64()
    if (pub) {
      void loadApprovedDevices()
        .then((store) => saveApprovedDevices(pinDevice(store, pub)))
        .catch(() => {
          // A failed pin is non-fatal: the device still works this session, it just re-prompts
          // next time. Never block approval on a disk write.
        })
    }
    s.approve()
  })
  ipcMain.on(IPC.remoteHostReject, () => {
    const s = pendingPeer
    if (!s) return
    pendingPeer = null
    // Drop this connection and re-register so a different phone can still connect later.
    dropSession()
    scheduleReconnect()
  })

  return {
    setEnabled(next) {
      enabled = next
      reconcile()
    },
    syncFromSettings() {
      enabled = !!getSettings().phoneAccessEnabled
      reconcile()
    },
    stop
  }
}

// ---------------------------------------------------------------------------------------------
// MANUAL SMOKE TEST (documented here, NOT automated — the live round-trip needs the deployed or a
// local relay + the iOS client, like test/remote/relay-e2e.test.ts's block):
//
//   Prereqs: a Pro-entitled desktop build (or NODETERM_RELAY_URL + NODETERM_API_BASE pointing at a
//   local relay/API), the nodeterm iOS app, and a phone already paired over the LAN.
//     1. Desktop: Settings → Phone → toggle "Remote access from your phone" ON. Main mints a
//        host-token (POST /v1/relay/host-token) and registers as role:'host' under hostId =
//        base64url(sha256(hostPublicKey)).slice(0,22).
//     2. Re-pair (or pair) the phone: the /pair response + QR now carry `relay {hostId,
//        hostPublicKeyB64, relayEndpoint}` + `relayDeviceToken`. Confirm the phone stored them.
//     3. Put the phone on cellular (OFF the LAN). It joins the relay (POST /v1/relay/join →
//        role:'client' under the same hostId) and bridges to the standing host.
//     4. FIRST connect: the desktop shows the SAS approval dialog. Approve → the phone attaches to
//        a tmux session (pty.attach) and the terminal streams. The device pubkey is pinned.
//     5. Disconnect + reconnect the phone: it now auto-approves (no dialog) — pin-once verified.
//     6. Leave it idle ~2 min: the host re-mints its token + reconnects (watch it stay reachable).
//     7. Toggle the setting OFF (or deactivate Pro): the standing host tears down; the phone can
//        no longer reach the Mac over the relay (LAN pairing still works).
//   Throughout, the relay only forwards opaque E2EE boxes — it never sees plaintext.
// ---------------------------------------------------------------------------------------------
