// Task 2 (docs/remote-sessions.md 4c): `initRelayHost` drives the reviewed `connectRelayHost`
// machinery from IPC — a real peer connecting fires the approval prompt, and ONLY after the human
// confirms does the peer become a live CorePlatform client.
//
// The reviewed trust machinery (connectRelayHost / createTrustGate / relay-socket) is exercised for
// REAL here; only the electron shell boundary and the relay WIRE (an in-process RelayTransport pair,
// the same fake relay-host.test.ts drives) are faked. The token mint + keypair + Pro gate are
// injected via `deps` so the test never touches the network or the OS keyring.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h: {
  handlers: Record<string, (...a: any[]) => unknown>
  sent: Array<{ channel: string; args: any[] }>
} = { handlers: {}, sent: [] }

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/ud', getVersion: () => '9.9.9', isPackaged: false },
  ipcMain: {
    handle: (ch: string, fn: (...a: any[]) => unknown) => {
      h.handlers[ch] = fn
    },
    on: (ch: string, fn: (...a: any[]) => void) => {
      h.handlers[ch] = fn
    }
  },
  webContents: { fromId: () => undefined },
  shell: { openExternal: vi.fn(async () => {}) }
}))

vi.mock('../main-window', () => ({
  sendToMain: (ch: string, ...args: any[]) => h.sent.push({ channel: ch, args }),
  mainWindowClientIds: () => [] as number[]
}))

import { emptyApprovedDevices, type ApprovedDevices } from './approved-devices-core'
let disk: ApprovedDevices = emptyApprovedDevices()
vi.mock('./approved-devices', () => ({
  loadApprovedDevices: async () => disk,
  saveApprovedDevices: async (s: ApprovedDevices) => {
    disk = s
  }
}))

import { initRelayHost } from './relay-host-service'
import type { RelayHostSession } from './relay-host'
import { connectRelay, type RelayTransport } from './relay-socket'
import { createTrustGate, type TrustGate } from './relay-trust'
import { genKeyPair, publicKeyToB64 } from './e2ee'
import { decodeOffer } from './pairing'
import { electronPlatform, type ElectronPlatform } from '../platform-electron'
import { peerRegistry, unregisterPeerSink, wirePeerRegistry } from '../peer-registry'
import { presenceHub } from '../../core/presence/hub'
import { initCanvasSync } from '../../core/canvas-sync'
import { initPlatform, resetPlatformForTests } from '../../core/platform'
import { IPC } from '../../shared/ipc'

const decoder = new TextDecoder()

let platform: ElectronPlatform

/** A fake window that records what the main process pushes to the renderer. */
function fakeWin(): { isDestroyed: () => boolean; webContents: { send: (ch: string, ...a: any[]) => void } } {
  return {
    isDestroyed: () => false,
    webContents: { send: (ch: string, ...args: any[]) => h.sent.push({ channel: ch, args }) }
  }
}

/**
 * Wire an `initRelayHost` whose relay socket is an in-process transport pair, and return a peer that
 * can drive the handshake + trust confirm. The host transport is injected via `deps.transport`; the
 * token mint / keypair / Pro gate are injected so nothing hits the network.
 */
function wireHost(): {
  win: ReturnType<typeof fakeWin>
  hostKeys: ReturnType<typeof genKeyPair>
  peerKeyB64: string
  /** Complete the E2EE handshake from the peer side (creates the peer relay socket). */
  connectPeer: () => void
  /** The peer human presses Confirm over the ENCRYPTED tunnel. */
  peerConfirms: () => void
  /** The relay drops the socket under the host. */
  dropSocket: () => void
} {
  const hostKeys = genKeyPair()
  const peerKeys = genKeyPair()

  let hostOnMsg: ((d: unknown) => void) | null = null
  let peerOnMsg: ((d: unknown) => void) | null = null
  let hostOnClose: (() => void) | null = null
  let peerOnClose: (() => void) | null = null

  const hostT: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => peerOnMsg?.(d),
    close: () => peerOnClose?.(),
    onMessage: (cb) => {
      hostOnMsg = cb
    },
    onClose: (cb) => {
      hostOnClose = cb
    }
  }
  const peerT: RelayTransport = {
    bufferedAmount: 0,
    send: (d) => hostOnMsg?.(d),
    close: () => hostOnClose?.(),
    onMessage: (cb) => {
      peerOnMsg = cb
    },
    onClose: (cb) => {
      peerOnClose = cb
    }
  }

  const win = fakeWin()
  initRelayHost(win as never, platform, {
    transport: hostT,
    loadKeys: async () => hostKeys,
    mintToken: async () => ({ pairingToken: 'tok-123' }),
    isPremium: () => true,
    relayAllowed: () => true,
    getEntitlement: () => 'ent-abc'
  })

  let peerGate: TrustGate | null = null
  let peerStore: ApprovedDevices = emptyApprovedDevices()

  const connectPeer = (): void => {
    const peerSocket = connectRelay({
      url: 'wss://relay.example',
      token: 'tok-123',
      role: 'client',
      ourKeys: peerKeys,
      theirPubB64: publicKeyToB64(hostKeys.publicKey),
      transport: peerT,
      onReady: () => {},
      onRpc: () => {},
      onFrame: () => {},
      onClose: () => {},
      onTunnel: (kind, payload) => {
        if (kind !== 'text') return
        const json = decoder.decode(payload)
        peerGate?.onTunnelText(json)
      }
    })
    peerGate = createTrustGate({
      peerKeyB64: peerSocket.peerPublicKeyB64()!,
      sessionId: 'peer-side',
      sas: () => peerSocket.sas(),
      sendConfirm: (json) => peerSocket.sendTunnelText(json),
      onOpen: () => {},
      load: async () => peerStore,
      save: async (s) => {
        peerStore = s
      }
    })
  }

  return {
    win,
    hostKeys,
    peerKeyB64: publicKeyToB64(peerKeys.publicKey),
    connectPeer,
    peerConfirms: () => peerGate?.confirmHere(),
    dropSocket: () => hostOnClose?.()
  }
}

/** Run `relay:host:start` and return its offer. */
async function start(): Promise<{ offer: string }> {
  return (await h.handlers[IPC.relayHostStart]({})) as { offer: string }
}

function pendingSent(): { id: string; sas: string | null; peerKeyB64: string } | undefined {
  return h.sent.filter((x) => x.channel === IPC.relayHostPeerPending).at(-1)?.args[0]
}

beforeEach(() => {
  h.handlers = {}
  h.sent = []
  disk = emptyApprovedDevices()
  platform = electronPlatform()
  initPlatform(platform)
  wirePeerRegistry({
    setFlow: () => {},
    captureForResync: async () => '',
    onPeerGone: () => {}
  })
  presenceHub.registerIpc()
  initCanvasSync()
})

afterEach(() => {
  for (const id of peerRegistry().ids()) unregisterPeerSink(id)
  for (const pe of presenceHub.peers()) presenceHub.leave(pe.clientId)
  resetPlatformForTests()
})

describe('initRelayHost — start()', () => {
  it('returns a decodable offer carrying the host key + minted token', async () => {
    wireHost()
    const { offer } = await start()
    const decoded = decodeOffer(offer)
    expect(decoded).toBeTruthy()
    expect(decoded!.pairingToken).toBe('tok-123')
    expect(decoded!.hostPublicKeyB64).toBeTruthy()
  })

  it('rejects when not entitled', async () => {
    const win = fakeWin()
    initRelayHost(win as never, platform, {
      isPremium: () => false,
      relayAllowed: () => true,
      getEntitlement: () => 'ent',
      loadKeys: async () => genKeyPair(),
      mintToken: async () => ({ pairingToken: 't' })
    })
    await expect(h.handlers[IPC.relayHostStart]({})).rejects.toThrow(/Pro/)
  })

  it('surfaces a locked peer key as a rejected start', async () => {
    const win = fakeWin()
    initRelayHost(win as never, platform, {
      isPremium: () => true,
      relayAllowed: () => true,
      getEntitlement: () => 'ent',
      loadKeys: async () => {
        throw Object.assign(new Error('locked'), { code: 'E_PEER_KEY_LOCKED' })
      },
      mintToken: async () => ({ pairingToken: 't' })
    })
    await expect(h.handlers[IPC.relayHostStart]({})).rejects.toThrow(/locked/)
  })
})

describe('initRelayHost — nothing is served before mutual approval', () => {
  it('a peer completing the handshake fires relayHostPeerPending with a non-null SAS but no client yet', async () => {
    const host = wireHost()
    await start()
    host.connectPeer()

    const pending = pendingSent()
    expect(pending).toBeTruthy()
    expect(pending!.sas).toMatch(/^\d{3} \d{3}$/)
    expect(pending!.peerKeyB64).toBe(host.peerKeyB64)
    // No client, no presence, no open before the human confirms.
    expect(peerRegistry().ids()).toEqual([])
    expect(presenceHub.peers()).toEqual([])
    expect(h.sent.some((x) => x.channel === IPC.relayHostOpen)).toBe(false)
  })

  it('ONE human confirming (the peer alone) is not enough', async () => {
    const host = wireHost()
    await start()
    host.connectPeer()
    host.peerConfirms() // only the remote human
    await new Promise((r) => setTimeout(r, 20))
    expect(peerRegistry().ids()).toEqual([])
    expect(h.sent.some((x) => x.channel === IPC.relayHostOpen)).toBe(false)
  })
})

describe('initRelayHost — confirm() opens the session', () => {
  it('both humans confirming admits the peer as a CorePlatform client + presence peer', async () => {
    const host = wireHost()
    await start()
    host.connectPeer()
    const id = pendingSent()!.id

    // This human confirms via IPC, the remote human over the tunnel.
    h.handlers[IPC.relayHostConfirm]({}, { id })
    host.peerConfirms()

    await vi.waitFor(() => expect(peerRegistry().ids().length).toBe(1))
    expect(presenceHub.peers().length).toBe(1)
    expect(presenceHub.peers()[0].kind).toBe('desktop')
    const open = h.sent.filter((x) => x.channel === IPC.relayHostOpen).at(-1)
    expect(open?.args[0]).toEqual({ id })
  })

  it('confirm() with an unknown id is a no-op (no throw)', async () => {
    wireHost()
    await start()
    expect(() => h.handlers[IPC.relayHostConfirm]({}, { id: 'nope' })).not.toThrow()
    expect(peerRegistry().ids()).toEqual([])
  })
})

describe('initRelayHost — sharedProjectId threads start → connect', () => {
  /** Inject a fake `connect` that records the options it was called with. */
  function wireWithCapture(): { opts: () => any } {
    let captured: any = null
    const win = fakeWin()
    initRelayHost(win as never, platform, {
      loadKeys: async () => genKeyPair(),
      mintToken: async () => ({ pairingToken: 'tok-123' }),
      isPremium: () => true,
      relayAllowed: () => true,
      getEntitlement: () => 'ent-abc',
      connect: (o) => {
        captured = o
        // A no-op session; start() only needs the offer, which it builds itself.
        return {
          clientId: () => null,
          sas: () => null,
          peerKeyB64: () => null,
          sharedProjectId: () => o.sharedProjectId,
          confirm: () => {},
          close: () => {}
        } as unknown as RelayHostSession
      }
    })
    return { opts: () => captured }
  }

  it('start(projectId) passes sharedProjectId to connect', async () => {
    const cap = wireWithCapture()
    await h.handlers[IPC.relayHostStart]({}, 'proj-1')
    expect(cap.opts()?.sharedProjectId).toBe('proj-1')
  })

  it('start() with no arg leaves sharedProjectId undefined', async () => {
    const cap = wireWithCapture()
    await h.handlers[IPC.relayHostStart]({})
    expect(cap.opts()?.sharedProjectId).toBeUndefined()
  })
})

describe('initRelayHost — teardown', () => {
  it('stop() tears the live peer down and notifies the renderer', async () => {
    const host = wireHost()
    await start()
    host.connectPeer()
    const id = pendingSent()!.id
    h.handlers[IPC.relayHostConfirm]({}, { id })
    host.peerConfirms()
    await vi.waitFor(() => expect(peerRegistry().ids().length).toBe(1))

    await h.handlers[IPC.relayHostStop]()

    expect(peerRegistry().ids()).toEqual([])
    expect(presenceHub.peers()).toEqual([])
  })

  it('a socket drop tears the peer down and fires relayHostClosed', async () => {
    const host = wireHost()
    await start()
    host.connectPeer()
    const id = pendingSent()!.id
    h.handlers[IPC.relayHostConfirm]({}, { id })
    host.peerConfirms()
    await vi.waitFor(() => expect(peerRegistry().ids().length).toBe(1))

    host.dropSocket()

    expect(peerRegistry().ids()).toEqual([])
    expect(presenceHub.peers()).toEqual([])
    const closed = h.sent.filter((x) => x.channel === IPC.relayHostClosed).at(-1)
    expect(closed?.args[0]).toEqual({ id })
  })
})
