import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  registerPeerSink,
  unregisterPeerSink,
  peerRegistry,
  wirePeerRegistry,
  type UiSink
} from './peer-registry'
import { presenceHub, allocateRelayClientId } from '../core/presence/hub'
import { initPlatform, resetPlatformForTests, type CorePlatform } from '../core/platform'
import { IPC } from '../shared/ipc'
import { decodePtyData } from '../shared/rpc'

/** A fake peer sink that records everything the core pushed at it. */
function fakeSink(buffered = () => 0) {
  const text: any[] = []
  const binary: Uint8Array[] = []
  const sink: UiSink = {
    sendText: (json) => text.push(JSON.parse(json)),
    sendBinary: (buf) => binary.push(buf),
    bufferedAmount: buffered
  }
  return { sink, text, binary }
}

/**
 * The CorePlatform Task 4 will build for real in platform-electron.ts: a webContents path, plus a
 * peer path that routes sendTo / broadcast / clientIds through the peer registry. Modelled here so
 * this module's seam can be proven end-to-end (presence + canvas + pty all reach a peer sink)
 * without electron.
 */
function fakePlatformWithPeers(wc: { sent: Array<{ id: number; channel: string; args: any[] }> }) {
  const wcIds = [1]
  const p: CorePlatform = {
    userDataDir: '/tmp/ud',
    appVersion: '0.0.0',
    isPackaged: false,
    handle: () => {},
    on: () => {},
    handleWithSender: () => {},
    onWithSender: () => {},
    sendTo: (id, ch, ...args) => {
      if (peerRegistry().has(id)) {
        peerRegistry().sendTo(id, ch, ...args)
        return
      }
      wc.sent.push({ id, channel: ch, args })
    },
    broadcast: (ch, ...args) => {
      for (const id of wcIds) wc.sent.push({ id, channel: ch, args })
      for (const id of peerRegistry().ids()) peerRegistry().sendTo(id, ch, ...args)
    },
    clientIds: () => [...wcIds, ...peerRegistry().ids()],
    openExternal: async () => {}
  }
  initPlatform(p)
  return p
}

let gone: number[]
let flow: Array<[number, string, boolean, string]>

beforeEach(() => {
  gone = []
  flow = []
  wirePeerRegistry({
    setFlow: (id, sid, resume, owner) => flow.push([id, sid, resume, owner]),
    captureForResync: async () => '',
    onPeerGone: (id) => gone.push(id)
  })
})

afterEach(() => {
  // No cross-test leak: every peer this test registered is torn down.
  for (const id of peerRegistry().ids()) unregisterPeerSink(id)
  resetPlatformForTests()
  vi.useRealTimers()
})

describe('peer sink registry', () => {
  it('registerPeerSink adds a sink the registry tracks, under a non-colliding id', () => {
    fakePlatformWithPeers({ sent: [] })
    const id = allocateRelayClientId()
    registerPeerSink(id, fakeSink().sink)
    expect(peerRegistry().has(id)).toBe(true)
    expect(peerRegistry().ids()).toContain(id)
    expect(id).toBeGreaterThanOrEqual(1_000_000)
  })

  it('a peer sink receives presence, canvas broadcasts and pty output', () => {
    const wc = { sent: [] as Array<{ id: number; channel: string; args: any[] }> }
    const platform = fakePlatformWithPeers(wc)
    const id = allocateRelayClientId()
    const peer = fakeSink()
    registerPeerSink(id, peer.sink)

    // presence: join sendTo's the whole table at the newcomer, then broadcasts the join diff.
    presenceHub.join(id, 'phone')
    expect(peer.text.map((m) => m.channel)).toContain(IPC.presenceSync)
    expect(peer.text.map((m) => m.channel)).toContain(IPC.presencePeer)

    // canvas: a mutation fans out via broadcast — the peer is one of the recipients.
    platform.broadcast(IPC.canvasMut, { seq: 1 })
    expect(peer.text.at(-1)).toEqual({ t: 'ev', channel: IPC.canvasMut, args: [{ seq: 1 }] })
    // …and the webContents client still got it too (the peer does not displace it).
    expect(wc.sent.some((s) => s.channel === IPC.canvasMut)).toBe(true)

    // pty: per-session output reaches the peer as a binary frame.
    platform.sendTo(id, IPC.ptyData('nt-a'), 'hello')
    expect(peer.binary).toHaveLength(1)
    expect(decodePtyData(peer.binary[0]!)).toEqual({ sessionId: 'nt-a', data: 'hello' })
    // and nothing of the peer's leaked onto the webContents path.
    expect(wc.sent.some((s) => s.channel.startsWith('pty:data:'))).toBe(false)
  })

  it('unregisterPeerSink runs the FULL teardown: leave + dropClient + flow/desync clear', () => {
    fakePlatformWithPeers({ sent: [] })
    const id = allocateRelayClientId()
    registerPeerSink(id, fakeSink().sink)
    presenceHub.join(id, 'phone')
    expect(presenceHub.peers().some((p) => p.clientId === id)).toBe(true)

    unregisterPeerSink(id)

    expect(presenceHub.peers().some((p) => p.clientId === id)).toBe(false) // no ghost peer
    expect(gone).toEqual([id]) // PtyManager.dropClient(id)
    expect(peerRegistry().has(id)).toBe(false) // sink + flow/desync bookkeeping cleared
  })

  it('teardown leaves no pause owed and no live sweep timer behind', () => {
    vi.useFakeTimers()
    const platform = fakePlatformWithPeers({ sent: [] })
    const id = allocateRelayClientId()
    // A peer whose socket is jammed: the registry pauses the pty for it and arms the drain sweep.
    registerPeerSink(id, fakeSink(() => 2_000_000).sink)
    platform.sendTo(id, IPC.ptyData('nt-a'), 'x')
    expect(flow).toEqual([[id, 'nt-a', false, 'socket']])
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    unregisterPeerSink(id)

    // The pause is returned by PtyManager.dropClient (the onPeerGone hook), never re-asserted or
    // re-resumed here; the sweep that would have done it is gone with its last client.
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5_000)
    expect(flow).toEqual([[id, 'nt-a', false, 'socket']])
  })
})
