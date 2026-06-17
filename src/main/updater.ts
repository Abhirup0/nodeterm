// Auto-update client (electron-updater). The packaged app downloads updates automatically
// and forwards the full lifecycle (available → progress → downloaded → error/not-available)
// to the renderer's UpdateCard. Version lookup, manual check, and restart work in dev too;
// the automatic feed checks and event wiring are packaged-only. On macOS, silent self-install
// requires a signed + notarized build; unsigned builds still surface the card for a manual
// download.
import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import electronUpdater from 'electron-updater'
import { IPC } from '../shared/ipc'

const { autoUpdater } = electronUpdater

const SIX_HOURS = 6 * 60 * 60 * 1000

export function initUpdater(win: BrowserWindow): void {
  const send = (channel: string, payload?: unknown) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  // Always available, even in dev: current version, manual check, restart.
  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())
  ipcMain.on(IPC.appRestartToUpdate, () => autoUpdater.quitAndInstall())

  if (!app.isPackaged) {
    // Dev: there is no update server. A manual check reports "up to date" so the Settings
    // button still gives feedback; automatic checks are skipped entirely.
    ipcMain.on(IPC.appCheckForUpdates, () => send(IPC.appUpdateNotAvailable))
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    send(IPC.appUpdateAvailable, { version: info.version, notes: info.releaseNotes ?? '' })
  })

  autoUpdater.on('download-progress', (p) => {
    send(IPC.appUpdateProgress, {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    send(IPC.appUpdateDownloaded, { version: info.version })
    // OS notification only when the window is in the background; the card covers the foreground.
    if (!win.isFocused() && Notification.isSupported()) {
      const n = new Notification({
        title: 'Update ready',
        body: `nodeterm ${info.version} is ready to install.`
      })
      n.on('click', () => {
        if (win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      })
      n.show()
    }
  })

  autoUpdater.on('update-not-available', () => send(IPC.appUpdateNotAvailable))

  autoUpdater.on('error', (err) => {
    const message = err?.message ?? String(err)
    console.error('[updater]', message)
    send(IPC.appUpdateError, message)
  })

  // Manual check from Settings; surfaces failures to the card.
  ipcMain.on(IPC.appCheckForUpdates, () => {
    autoUpdater.checkForUpdates().catch((err) => {
      const message = err?.message ?? String(err)
      console.error('[updater]', message)
      send(IPC.appUpdateError, message)
    })
  })

  // Automatic checks: on launch and every six hours.
  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[updater]', err?.message ?? err))
  }
  check()
  setInterval(check, SIX_HOURS)
}
