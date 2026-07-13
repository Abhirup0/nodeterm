import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h: {
  handlers: Record<string, (...a: any[]) => unknown>
  sent: Array<{ id?: number; channel: string; args: any[] }>
  clientIds: number[]
} = { handlers: {}, sent: [], clientIds: [] }

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/ud',
    getVersion: () => '9.9.9',
    isPackaged: false,
  },
  ipcMain: {
    handle: (ch: string, fn: (...a: any[]) => unknown) => {
      h.handlers[ch] = fn
    },
    on: (ch: string, fn: (...a: any[]) => void) => {
      h.handlers[ch] = fn
    },
  },
  webContents: {
    fromId: (id: number) =>
      id === 1
        ? { isDestroyed: () => false, send: (ch: string, ...args: any[]) => h.sent.push({ id, channel: ch, args }) }
        : undefined,
  },
  shell: { openExternal: vi.fn(async () => {}) },
}))

vi.mock('./main-window', () => ({
  sendToMain: (ch: string, ...args: any[]) => h.sent.push({ channel: ch, args }),
  mainWindowClientIds: () => h.clientIds,
}))

import { electronPlatform } from './platform-electron'
import {
  registerPeerSink,
  unregisterPeerSink,
  peerRegistry,
  wirePeerRegistry,
  type UiSink
} from './peer-registry'
import { decodePtyData } from '../shared/rpc'

/** A relay peer id, as allocateRelayClientId() would mint it (≥ 1_000_000 — never a webContents id). */
const PEER = 1_000_000

/** A fake peer sink recording everything the platform pushed at it. */
function peerSink() {
  const text: string[] = []
  const binary: Uint8Array[] = []
  const sink: UiSink = {
    sendText: (json) => text.push(json),
    sendBinary: (buf) => binary.push(buf),
    bufferedAmount: () => 0
  }
  return { text, binary, sink }
}

beforeEach(() => {
  h.handlers = {}
  h.sent = []
  h.clientIds = []
  wirePeerRegistry({
    setFlow: () => {},
    captureForResync: async () => '',
    onPeerGone: () => {}
  })
})

afterEach(() => {
  // No cross-test leak: whatever a test registered is torn down (presence leave + registry prune).
  for (const id of peerRegistry().ids()) unregisterPeerSink(id)
})

describe('electronPlatform', () => {
  it('exposes app paths and version', () => {
    const p = electronPlatform()
    expect(p.userDataDir).toBe('/tmp/ud')
    expect(p.appVersion).toBe('9.9.9')
    expect(p.isPackaged).toBe(false)
  })

  it('strips the ipc event from handle/on and forwards sender id in handleWithSender', async () => {
    const p = electronPlatform()
    p.handle('c1', (a: number) => a + 1)
    expect(await h.handlers['c1']({ sender: { id: 1 } }, 41)).toBe(42)
    p.handleWithSender('c2', (senderId: number, a: string) => `${senderId}:${a}`)
    expect(await h.handlers['c2']({ sender: { id: 7 } }, 'x')).toBe('7:x')
  })

  it('clientIds reports the live main window (empty while there is no window)', () => {
    const p = electronPlatform()
    expect(p.clientIds()).toEqual([])
    h.clientIds = [5]
    expect(p.clientIds()).toEqual([5])
  })

  it('sendTo drops silently when the webContents is gone', () => {
    const p = electronPlatform()
    p.sendTo(1, 'ev', 'a')
    p.sendTo(999, 'ev', 'b') // must not throw
    expect(h.sent).toEqual([{ id: 1, channel: 'ev', args: ['a'] }])
  })
})

/**
 * The seam that makes a relay peer a FIRST-CLASS client of this desktop's core: a peer has no
 * webContents, so before this every sendTo/broadcast aimed at one silently no-op'd (the host saw the
 * phone, the phone saw nothing). All three members are now peer-aware — and, with no peer
 * registered, bit-identical to the webContents-only code they replaced.
 */
describe('electronPlatform + relay peers', () => {
  it('clientIds = webContents ids ++ peer ids', () => {
    const p = electronPlatform()
    h.clientIds = [5]
    registerPeerSink(PEER, peerSink().sink)
    expect(p.clientIds()).toEqual([5, PEER])
  })

  it('sendTo dispatches a peer id to its sink and a webContents id natively', () => {
    const p = electronPlatform()
    const s = peerSink()
    registerPeerSink(PEER, s.sink)

    p.sendTo(PEER, 'presence:sync', [{ clientId: PEER }])
    expect(JSON.parse(s.text[0]!)).toEqual({
      t: 'ev',
      channel: 'presence:sync',
      args: [[{ clientId: PEER }]]
    })
    expect(h.sent).toEqual([]) // nothing of the peer's leaked onto the webContents path

    p.sendTo(1, 'ev', 'a')
    expect(h.sent).toEqual([{ id: 1, channel: 'ev', args: ['a'] }])
    expect(s.text).toHaveLength(1) // …and the webContents send did not reach the peer
  })

  it('sendTo routes a pty:data frame to the peer sink as BINARY', () => {
    const p = electronPlatform()
    const s = peerSink()
    registerPeerSink(PEER, s.sink)
    p.sendTo(PEER, 'pty:data:s1', 'hi')
    expect(s.binary).toHaveLength(1)
    expect(decodePtyData(s.binary[0]!)).toEqual({ sessionId: 's1', data: 'hi' })
  })

  it('broadcast reaches the main window AND every peer sink', () => {
    const p = electronPlatform()
    h.clientIds = [1]
    const s = peerSink()
    registerPeerSink(PEER, s.sink)
    p.broadcast('presence:peer', { op: 'join' })
    expect(h.sent).toContainEqual({ channel: 'presence:peer', args: [{ op: 'join' }] })
    expect(JSON.parse(s.text[0]!)).toEqual({
      t: 'ev',
      channel: 'presence:peer',
      args: [{ op: 'join' }]
    })
  })

  it('one peer whose sink throws does not starve the other peers, the window, or the emitter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = electronPlatform()
    h.clientIds = [1]
    const dead: UiSink = {
      sendText: () => {
        throw new Error('EPIPE: relay socket half-closed')
      },
      sendBinary: () => {},
      bufferedAmount: () => 0
    }
    const alive = peerSink()
    registerPeerSink(PEER, dead)
    registerPeerSink(PEER + 1, alive.sink)

    // The exact 4c failure: a presence diff / canvas mutation fans out while peer B's socket is
    // dead. It must not unwind out of broadcast (that would blow up presenceHub.emit / the canvas
    // reflector on the HOST) and peer C must still be served.
    expect(() => p.broadcast('presence:peer', { op: 'join' })).not.toThrow()
    expect(h.sent).toContainEqual({ channel: 'presence:peer', args: [{ op: 'join' }] })
    expect(JSON.parse(alive.text[0]!)).toEqual({
      t: 'ev',
      channel: 'presence:peer',
      args: [{ op: 'join' }]
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('is BIT-IDENTICAL to the webContents-only path with no peer registered (merge gate)', () => {
    const p = electronPlatform()
    h.clientIds = [5]
    expect(p.clientIds()).toEqual([5]) // no peer artefact appended
    p.sendTo(1, 'ev', 'a')
    p.sendTo(999, 'ev', 'b') // unknown id → silent, exactly as before
    expect(h.sent).toEqual([{ id: 1, channel: 'ev', args: ['a'] }])
    h.sent.length = 0
    p.broadcast('x', 1)
    expect(h.sent).toEqual([{ channel: 'x', args: [1] }]) // exactly sendToMain, nothing else
  })
})
