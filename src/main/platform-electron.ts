import { app, ipcMain, shell, webContents } from 'electron'
import type { CorePlatform } from '../core/platform'
import { sendToMain } from './main-window'

/** The Electron shell's CorePlatform. Getters keep app.getPath lazy (safe pre-ready). */
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
      const wc = webContents.fromId(id)
      if (wc && !wc.isDestroyed()) wc.send(ch, ...args)
    },
    broadcast: (ch, ...args) => sendToMain(ch, ...args),
    openExternal: (url) => shell.openExternal(url),
  }
}
