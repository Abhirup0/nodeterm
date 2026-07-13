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
