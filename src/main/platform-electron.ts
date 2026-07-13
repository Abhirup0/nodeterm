import { app, ipcMain, shell, webContents } from 'electron'
import type { CorePlatform } from '../core/platform'
import { mainWindowClientIds, sendToMain } from './main-window'
import { peerRegistry } from './peer-registry'

/**
 * The Electron shell's CorePlatform. Getters keep app.getPath lazy (safe pre-ready).
 *
 * A client here is EITHER a webContents (the main window) OR a relay PEER — a phone, or another
 * desktop (4c) — addressed by a UiSink in the peer registry. Everything Stages 1-3 built (presence
 * hub, canvas reflector, terminal co-attach) is already written against CorePlatform and is
 * multi-client; a peer was half-joined only because these three members resolved ids through
 * `webContents.fromId` alone, so every send aimed at one silently no-op'd. Peer ids are minted ≥
 * 1_000_000 (allocateRelayClientId), so they can never collide with a webContents id.
 *
 * SOLO COST: zero. With no peer registered the registry holds an empty Map — `has` is a miss, `ids`
 * is empty — and the webContents path below is the code it replaced, byte for byte.
 */
export function electronPlatform(): CorePlatform {
  return {
    get userDataDir() {
      return app.getPath('userData')
    },
    get appVersion() {
      return app.getVersion()
    },
    get isPackaged() {
      return app.isPackaged
    },
    handle: (ch, fn) => ipcMain.handle(ch, (_e, ...args) => fn(...args)),
    on: (ch, fn) => ipcMain.on(ch, (_e, ...args) => fn(...args)),
    handleWithSender: (ch, fn) => ipcMain.handle(ch, (e, ...args) => fn(e.sender.id, ...args)),
    onWithSender: (ch, fn) => ipcMain.on(ch, (e, ...args) => fn(e.sender.id, ...args)),
    sendTo: (id, ch, ...args) => {
      // A peer id resolves to a UiSink (RPC-framed; pty:data goes out as a binary frame, with the
      // registry's WS backpressure). Everything else is a webContents, dispatched natively.
      const peers = peerRegistry()
      if (peers.has(id)) {
        peers.sendTo(id, ch, ...args)
        return
      }
      const wc = webContents.fromId(id)
      if (wc && !wc.isDestroyed()) wc.send(ch, ...args)
    },
    broadcast: (ch, ...args) => {
      sendToMain(ch, ...args) // the main window, exactly as before
      // …plus every relay peer. Not optional: presence diffs (presence:peer) and canvas mutations
      // fan out via broadcast, so a peer that only received sendTo would still see nothing.
      const peers = peerRegistry()
      if (peers.size === 0) return // solo desktop: no ids() array, no loop — allocation-free
      for (const id of peers.ids()) {
        // One peer must never break the fan-out. UiSinkRegistry.sendTo already contains a throwing
        // SINK (and evicts a dead one), so this only catches the rest of the path — the flow
        // controller it may call into. Either way the invariant is the same: an exception here
        // would skip every peer after this one AND unwind into the emitter (presenceHub.emit, the
        // canvas reflector), freezing the HOST's own presence/canvas over someone else's socket.
        try {
          peers.sendTo(id, ch, ...args)
        } catch (err) {
          console.warn(
            `[peer] broadcast of ${ch} to peer ${id} failed`,
            err instanceof Error ? err.message : String(err)
          )
        }
      }
    },
    clientIds: () => [...mainWindowClientIds(), ...peerRegistry().ids()],
    openExternal: (url) => shell.openExternal(url),
  }
}
