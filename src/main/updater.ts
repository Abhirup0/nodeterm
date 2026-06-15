// Auto-update client (electron-updater). Only runs in a packaged app; in dev it is a no-op.
// Flow: check on launch (and periodically) → on `update-available` notify the renderer →
// when the download finishes, notify again so the banner can offer "Restart to update".
// On macOS, silent self-install requires a signed + notarized build; unsigned builds still
// surface the banner so the user can download/install manually.
import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import { IPC } from '../shared/ipc'

const { autoUpdater } = electronUpdater

const SIX_HOURS = 6 * 60 * 60 * 1000

export function initUpdater(win: BrowserWindow): void {
  if (!app.isPackaged) return // dev: no update server, skip entirely

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  const send = (channel: string, payload?: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  autoUpdater.on('update-available', (info) => {
    send(IPC.appUpdateAvailable, { version: info.version, notes: info.releaseNotes ?? '' })
  })

  autoUpdater.on('update-downloaded', (info) => {
    send(IPC.appUpdateDownloaded, { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    console.error('[updater]', err?.message ?? err)
  })

  // User accepted the banner → quit and install the staged update.
  ipcMain.on(IPC.appRestartToUpdate, () => {
    autoUpdater.quitAndInstall()
  })

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[updater]', err?.message ?? err))
  }
  check()
  setInterval(check, SIX_HOURS)
}
