import { join } from 'path'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { IPC } from '../shared/ipc'
import { PtyManager } from './pty-manager'
import { WorkspaceStore } from './workspace-store'
import { SettingsStore } from './settings-store'
import { GitService } from './git-service'
import { generateCommitMessage, generateTerminalName } from './commit-message'
import { initUpdater } from './updater'
import { fetchAnnouncements } from './announcements'
import { initClaudeHooks } from './claude-hooks'

const settingsStore = new SettingsStore()
const ptyManager = new PtyManager()
const workspaceStore = new WorkspaceStore()
const gitService = new GitService()

// The single app window — kept at module scope so IPC handlers (e.g. notifications)
// can check focus and route clicks back to the renderer.
let mainWin: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#1e1e1e',
    title: 'node-terminal',
    // Integrate the macOS traffic lights into our top bar (modern Mac app look).
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Intercept Cmd/Ctrl+M (default = minimize) and route it to the renderer for the
  // markdown-view toggle instead.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.meta || input.control)) return
    const key = input.key.toLowerCase()
    if (key === 'm') {
      event.preventDefault()
      win.webContents.send(IPC.appToggleMarkdown)
    } else if (key === 'w' && !input.shift) {
      // Repurpose Cmd/Ctrl+W: the renderer closes the selected node(s); if none are
      // selected it asks us to close the window (the standard behavior).
      event.preventDefault()
      win.webContents.send(IPC.appCloseNode)
    }
  })

  // Open external links in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Load the electron-vite dev server if present, otherwise the built file.
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  settingsStore.init()
  settingsStore.registerIpc()
  ptyManager.init(() => settingsStore.get())
  ptyManager.registerIpc()
  workspaceStore.registerIpc()
  gitService.registerIpc()

  ipcMain.handle(IPC.commitGenerate, (_e, cwd: string) =>
    generateCommitMessage(cwd, settingsStore.get())
  )

  ipcMain.handle(IPC.ptyGenerateName, (_e, persistKey: string, cwd: string) =>
    generateTerminalName(ptyManager.captureSession(persistKey), cwd, settingsStore.get())
  )

  ipcMain.handle(IPC.ptyCapture, (_e, persistKey: string) => ptyManager.captureSession(persistKey))

  ipcMain.on(IPC.appCloseWindow, () => BrowserWindow.getFocusedWindow()?.close())

  // Show an OS notification — but only when the window is in the background. Clicking it
  // brings the app forward and asks the renderer to focus the originating node.
  ipcMain.handle(IPC.appNotify, (_e, payload: { title: string; body: string; nodeId: string }) => {
    if (!mainWin || mainWin.isFocused() || !Notification.isSupported()) return false
    const n = new Notification({ title: payload.title, body: payload.body })
    n.on('click', () => {
      if (!mainWin) return
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.show()
      mainWin.focus()
      mainWin.webContents.send(IPC.appFocusNode, payload.nodeId)
    })
    n.show()
    return true
  })

  ipcMain.handle(IPC.announcementsFetch, () => fetchAnnouncements())

  ipcMain.on(IPC.shellReveal, (_e, p: string) => {
    if (p) shell.showItemInFolder(p)
  })

  ipcMain.on(IPC.shellOpenPath, (_e, p: string) => {
    if (p) void shell.openPath(p)
  })

  ipcMain.handle(IPC.fsList, async (_e, dirPath: string) => {
    try {
      const dirents = await fs.readdir(dirPath, { withFileTypes: true })
      const entries = dirents
        .filter((e) => e.name !== '.git')
        .map((e) => ({ name: e.name, dir: e.isDirectory(), ignored: false }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))

      // Mark git-ignored entries (so the explorer can dim them).
      if (entries.length) {
        const run = promisify(execFile)
        const flag = (out: string) => {
          const set = new Set(
            out
              .split('\n')
              .map((s) => s.trim().replace(/\/$/, ''))
              .filter(Boolean)
          )
          for (const en of entries) if (set.has(en.name)) en.ignored = true
        }
        try {
          const { stdout } = await run(
            'git',
            ['-C', dirPath, 'check-ignore', '--', ...entries.map((e) => e.name)],
            { maxBuffer: 4 * 1024 * 1024 }
          )
          flag(stdout)
        } catch (err) {
          const out = (err as { stdout?: string }).stdout
          if (out) flag(out)
        }
      }
      return entries
    } catch {
      return []
    }
  })

  ipcMain.handle(IPC.fsRead, async (_e, filePath: string) => {
    try {
      return await fs.readFile(filePath, 'utf-8')
    } catch {
      return ''
    }
  })

  ipcMain.handle(IPC.fsReadBinary, async (_e, filePath: string) => {
    try {
      const buf = await fs.readFile(filePath)
      return buf.toString('base64')
    } catch {
      return ''
    }
  })

  ipcMain.handle(IPC.fsWrite, async (_e, filePath: string, content: string) => {
    try {
      await fs.writeFile(filePath, content, 'utf-8')
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle(IPC.dialogSelectFolder, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.dialogSelectFile, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  const win = createWindow()
  mainWin = win
  initUpdater(win)
  initClaudeHooks(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  ptyManager.killAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => ptyManager.killAll())
