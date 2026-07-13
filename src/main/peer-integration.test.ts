import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The INTEGRATION merge-gate for Stage 4b (docs/remote-sessions.md). The earlier tasks proved the
// seam with fakes; this proves the REAL objects compose. It boots the real electronPlatform, the
// real presenceHub, and the real canvas-sync reflector against it, registers a fake peer SINK, and
// shows the peer receives the SAME broadcasts the main window does — presence:sync / presence:peer
// and a seq-stamped canvas:mut. This is the moment the "half-joined peer" bug (host sees the phone;
// the phone is blind) is provably dead: nothing here is faked EXCEPT the electron shell boundary
// (electron + ./main-window, mocked exactly as platform-electron.test.ts does). The routing under
// test (electronPlatform.sendTo/clientIds/broadcast → peerRegistry), the presence hub, and the
// reflector are all the real, wired objects.

const h: {
  handlers: Record<string, (...a: any[]) => unknown>
  sent: Array<{ id?: number; channel: string; args: any[] }>
  clientIds: number[]
} = { handlers: {}, sent: [], clientIds: [] }

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/ud',
    getVersion: () => '9.9.9',
    isPackaged: false
  },
  ipcMain: {
    handle: (ch: string, fn: (...a: any[]) => unknown) => {
      h.handlers[ch] = fn
    },
    on: (ch: string, fn: (...a: any[]) => void) => {
      h.handlers[ch] = fn
    }
  },
  webContents: {
    fromId: (id: number) =>
      id === 1
        ? {
            isDestroyed: () => false,
            send: (ch: string, ...args: any[]) => h.sent.push({ id, channel: ch, args })
          }
        : undefined
  },
  shell: { openExternal: vi.fn(async () => {}) }
}))

vi.mock('./main-window', () => ({
  sendToMain: (ch: string, ...args: any[]) => h.sent.push({ channel: ch, args }),
  mainWindowClientIds: () => h.clientIds
}))

import { electronPlatform } from './platform-electron'
import {
  registerPeerSink,
  unregisterPeerSink,
  peerRegistry,
  wirePeerRegistry,
  type UiSink
} from './peer-registry'
import { presenceHub, allocateRelayClientId } from '../core/presence/hub'
import { initCanvasSync } from '../core/canvas-sync'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { IPC } from '../shared/ipc'
import { decodePtyData } from '../shared/rpc'

/** A fake relay peer sink — records every RPC frame the platform pushed at it. `t` is the text
 *  (event) frames, `b` the binary (pty:data) frames; `ui` is what registerPeerSink takes. */
function peerSink() {
  const t: string[] = []
  const b: Uint8Array[] = []
  const ui: UiSink = {
    sendText: (json) => t.push(json),
    sendBinary: (buf) => b.push(buf),
    bufferedAmount: () => 0
  }
  return { t, b, ui }
}

beforeEach(() => {
  h.handlers = {}
  h.sent = []
  h.clientIds = [1] // the main window (a webContents client)
  initPlatform(electronPlatform())
  // Boot wiring is inert (no peer registered yet); the noop onPeerGone keeps PtyManager out of an
  // integration test that is only about presence + canvas fan-out.
  wirePeerRegistry({
    setFlow: () => {},
    captureForResync: async () => '',
    onPeerGone: () => {}
  })
  presenceHub.registerIpc()
  initCanvasSync()
})

afterEach(() => {
  // Leave NO ghost in the hub and NO sink in the registry across tests (both are process singletons):
  // unregister drops each peer's sink AND leaves it from the hub; then leave any remaining (the
  // desktop window peer, which is not in the registry).
  for (const id of peerRegistry().ids()) unregisterPeerSink(id)
  for (const pe of presenceHub.peers()) presenceHub.leave(pe.clientId)
  resetPlatformForTests()
})

describe('peer integration — presence + canvas reflector reach a registered peer', () => {
  it('presence:sync + presence:peer reach a registered peer, and the desktop sees the peer join (merge-gate a)', () => {
    presenceHub.join(1, 'desktop') // the main window is a peer

    const peer = allocateRelayClientId()
    const s = peerSink()
    registerPeerSink(peer, s.ui)
    presenceHub.join(peer, 'phone')

    const frames = s.t.map((j) => JSON.parse(j))

    // The phone's join snapshot: it is NOT blind — it received the whole table, which includes the
    // desktop that joined before it.
    const sync = frames.find((m) => m.channel === IPC.presenceSync)
    expect(sync).toBeTruthy()
    expect(sync.args[0].some((pe: any) => pe.clientId === 1)).toBe(true)

    // …and the phone receives presence DIFFS (its own join, broadcast to every client) — the exact
    // frame it saw NONE of before 4b.
    const peerDiff = frames.find((m) => m.channel === IPC.presencePeer)
    expect(peerDiff).toBeTruthy()

    // The desktop (native webContents) sees the phone join too — presence is symmetric now.
    expect(
      h.sent.some(
        (x) => x.channel === IPC.presencePeer && x.args[0]?.op === 'join' && x.args[0]?.peer?.clientId === peer
      )
    ).toBe(true)
  })

  it('a later cursor MOVE by the desktop reaches the already-joined peer as a diff (merge-gate a)', () => {
    presenceHub.join(1, 'desktop')
    const peer = allocateRelayClientId()
    const s = peerSink()
    registerPeerSink(peer, s.ui)
    presenceHub.join(peer, 'phone')
    s.t.length = 0 // ignore the join traffic; watch what arrives AFTER the peer is settled

    presenceHub.setCursor(1, { x: 12, y: 34 })

    const move = s.t
      .map((j) => JSON.parse(j))
      .find(
        (m) =>
          m.channel === IPC.presencePeer &&
          m.args[0]?.op === 'update' &&
          m.args[0]?.clientId === 1 &&
          m.args[0]?.patch?.cursor
      )
    expect(move).toBeTruthy()
    expect(move.args[0].patch.cursor).toEqual({ x: 12, y: 34 })
  })

  it('canvas:mut is reflected to the peer, seq-stamped, sender-supplied seq overwritten (merge-gate b)', () => {
    const peer = allocateRelayClientId()
    const s = peerSink()
    registerPeerSink(peer, s.ui)
    // clientIds() must now return [1 (window), peer]; the reflector fans to every one of them.
    expect(electronPlatform().clientIds()).toEqual([1, peer])

    // A webContents client (id 1) edits → the peer must receive it, stamped seq 1 (the client's 999
    // is overwritten — seq is server-authoritative). NB: a valid upsert needs a finite position, or
    // isCanvasMutation refuses it at ingest and nothing reflects.
    h.handlers[IPC.canvasMut](
      { sender: { id: 1 } },
      'proj',
      { op: 'upsert', node: { id: 'n1', position: { x: 0, y: 0 } }, seq: 999 }
    )
    const got = s.t.map((j) => JSON.parse(j)).find((m) => m.channel === IPC.canvasMut)
    expect(got).toBeTruthy()
    expect(got.args[0]).toBe('proj')
    expect(got.args[1].seq).toBe(1)

    // A peer's OWN edit is reflected to ALL clients incl. its own ack (echo) AND the desktop, with a
    // monotone server seq (2). The sender receiving its seq-stamped ack IS merge-gate b's
    // echo-suppression contract at the reflector (the renderer-side drop is canvas-order's job).
    s.t.length = 0
    h.sent.length = 0
    h.handlers[IPC.canvasMut]({ sender: { id: peer } }, 'proj', { op: 'remove', id: 'n1' })

    expect(
      s.t.map((j) => JSON.parse(j)).some((m) => m.channel === IPC.canvasMut && m.args[1].seq === 2)
    ).toBe(true) // the peer's own ack
    expect(h.sent.some((x) => x.channel === IPC.canvasMut && x.args[1].seq === 2)).toBe(true) // the desktop
  })

  it('teardown: after unregisterPeerSink the peer stops receiving and leaves no ghost (merge-gate a + b)', () => {
    presenceHub.join(1, 'desktop')
    const peer = allocateRelayClientId()
    const s = peerSink()
    registerPeerSink(peer, s.ui)
    presenceHub.join(peer, 'phone')

    unregisterPeerSink(peer)

    // No ghost in the hub: the phone is gone from every snapshot, and the registry holds no id.
    expect(presenceHub.peers().some((pe) => pe.clientId === peer)).toBe(false)
    expect(peerRegistry().ids()).not.toContain(peer)
    // No longer a client of the reflector.
    expect(electronPlatform().clientIds()).toEqual([1])

    // Nothing reaches the (now dead) sink after teardown: neither a presence diff nor a canvas mut.
    s.t.length = 0
    presenceHub.setCursor(1, { x: 1, y: 2 })
    h.handlers[IPC.canvasMut](
      { sender: { id: 1 } },
      'proj',
      { op: 'upsert', node: { id: 'n2', position: { x: 0, y: 0 } } }
    )
    expect(s.t).toEqual([])
  })
})

// ── merge-gate c: pty OUTPUT fans out to a peer sink, with the full Stage-2 backpressure ──────────
//
// This is the property that lets a real remote peer CO-ATTACH to a desktop terminal: pty bytes reach
// the peer as BINARY frames (decodePtyData), and a peer that stops draining is paused, then — past
// the 8 MB WS_DROP_WATER ceiling — dropped and redrawn from a tmux capture, WITHOUT throttling or
// stalling a second, fast peer or the desktop's own window.
//
// Nothing here fakes the backpressure logic — that is the thing under test. What IS driven directly
// (not through a real node-pty) is the pty read loop: in production PtyManager fans a chunk out with
// `platform.sendTo(clientId, 'pty:data:<sid>', chunk)` per subscriber, so this composes the REAL
// electronPlatform + REAL peerRegistry/UiSinkRegistry + REAL wirePeerRegistry and calls that exact
// entry point. The tmux `captureForResync` and the PtyManager.setFlow actuator are the two injected
// seams (wirePeerRegistry's deps) and are the only stand-ins — exactly as backpressure.test.ts
// stands in for tmux/ptyManager on the Server Edition. This is the electron-side twin of
// src/server/backpressure.test.ts, sharing the extracted UiSinkRegistry.
describe('peer pty fan-out — binary frames + drop-and-redraw ceiling (merge-gate c)', () => {
  /** A peer sink with a caller-controlled `buffered` (== ws.bufferedAmount): the number Stage-2's
   *  ceiling keys on. `bins` are the pty:data binary frames; `resyncs` are the tmux redraws. */
  function ctlSink() {
    let buffered = 0
    const bins: Uint8Array[] = []
    const resyncs: string[] = []
    const ui: UiSink = {
      sendText: (json) => {
        const m = JSON.parse(json)
        if (String(m.channel).startsWith('pty:resync:')) resyncs.push(String(m.args[0]))
      },
      sendBinary: (b) => {
        bins.push(b)
        buffered += b.byteLength
      },
      bufferedAmount: () => buffered
    }
    return {
      ui,
      bins,
      resyncs,
      set: (n: number) => {
        buffered = n
      }
    }
  }

  it('pty output fans out to a peer via sendBinary, with the drop-and-redraw ceiling (merge-gate c)', async () => {
    const flow: Array<{ resume: boolean; owner: string }> = []
    wirePeerRegistry({
      setFlow: (_id, _sid, resume, owner) => flow.push({ resume, owner }),
      captureForResync: async () => 'CURRENT SCREEN',
      onPeerGone: () => {}
    })
    const p = electronPlatform()
    const peer = allocateRelayClientId()
    const s = ctlSink()
    registerPeerSink(peer, s.ui)

    // 1. A pty chunk reaches the peer as a BINARY frame the phone can decode back to (sid, data).
    p.sendTo(peer, 'pty:data:s1', 'hello')
    expect(decodePtyData(s.bins[0])).toEqual({ sessionId: 's1', data: 'hello' })

    // 2. Past WS_DROP_WATER the chunk is DROPPED, not queued — bounded memory, no unbounded backlog.
    s.set(9_000_000)
    p.sendTo(peer, 'pty:data:s1', 'flood')
    expect(s.bins).toHaveLength(1)

    // 3. The socket drains → the sweep redraws the peer from tmux exactly ONCE (current screen, not a
    //    replay of the 8 MB it missed).
    s.set(1000)
    await vi.waitFor(() => expect(s.resyncs).toEqual(['CURRENT SCREEN']))
  })

  it('pauses a slow peer at the high-water mark and resumes it below low, all under the socket owner', () => {
    const flow: Array<{ resume: boolean; owner: string }> = []
    wirePeerRegistry({
      setFlow: (_id, _sid, resume, owner) => flow.push({ resume, owner }),
      captureForResync: async () => 'SCREEN',
      onPeerGone: () => {}
    })
    const p = electronPlatform()
    const peer = allocateRelayClientId()
    const s = ctlSink()
    registerPeerSink(peer, s.ui)

    s.set(1_500_000) // above WS_HIGH_WATER (1 MB), below the drop ceiling
    p.sendTo(peer, 'pty:data:s1', 'chunk') // → pause the shared pty for this peer
    expect(flow).toEqual([{ resume: false, owner: 'socket' }])

    s.set(100_000) // drained below WS_LOW_WATER
    p.sendTo(peer, 'pty:data:s1', 'chunk') // → resume
    expect(flow).toEqual([
      { resume: false, owner: 'socket' },
      { resume: true, owner: 'socket' }
    ])
  })

  it('a slow peer over the ceiling stalls NEITHER a fast peer NOR the desktop window (co-attach isolation)', async () => {
    const flow: Array<{ id: number; resume: boolean }> = []
    wirePeerRegistry({
      setFlow: (id, _sid, resume) => flow.push({ id, resume }),
      captureForResync: async () => 'CURRENT SCREEN',
      onPeerGone: () => {}
    })
    const p = electronPlatform()
    const slowId = allocateRelayClientId()
    const fastId = allocateRelayClientId()
    const slow = ctlSink()
    const fast = ctlSink()
    slow.set(8_000_001) // already past WS_DROP_WATER
    registerPeerSink(slowId, slow.ui)
    registerPeerSink(fastId, fast.ui)

    // The pty read loop fans each chunk out to every subscriber: the slow peer, the fast peer, and
    // the desktop's own window (webContents id 1, mocked in `webContents.fromId`).
    for (let i = 0; i < 3; i++) {
      p.sendTo(slowId, 'pty:data:s1', 'chunk')
      p.sendTo(fastId, 'pty:data:s1', 'chunk')
      p.sendTo(1, 'pty:data:s1', 'chunk')
    }

    // The slow peer is dropped: nothing more is queued for it (its buffer cannot grow past the bound).
    expect(slow.bins).toHaveLength(0)
    // The fast peer keeps streaming, uninterrupted — one binary frame per chunk.
    expect(fast.bins).toHaveLength(3)
    expect(decodePtyData(fast.bins[2])).toEqual({ sessionId: 's1', data: 'chunk' })
    // The desktop window (native webContents send) is untouched by the slow peer entirely.
    expect(h.sent.filter((x) => x.id === 1 && x.channel === 'pty:data:s1')).toHaveLength(3)
    // And the shared pty is NEVER paused for the drowning peer — a per-client drop, not a global stall.
    expect(flow).toEqual([])

    // When the slow peer finally drains it is redrawn from tmux (once), while the fast peer and the
    // window were never affected.
    slow.set(1000)
    await vi.waitFor(() => expect(slow.resyncs).toEqual(['CURRENT SCREEN']))
    expect(fast.bins).toHaveLength(3)
  })
})
