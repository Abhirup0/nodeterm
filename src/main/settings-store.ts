import { promises as fs, readFileSync } from 'fs'
import path from 'path'
import { app, ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

/**
 * Stores user settings in settings.json. Keeps a synchronous cache so the PtyManager
 * can read shell/tmux preferences immediately at terminal creation.
 */
export class SettingsStore {
  private cache: Settings = DEFAULT_SETTINGS

  private get filePath(): string {
    return path.join(app.getPath('userData'), 'settings.json')
  }

  /** Load synchronously into cache (call after app is ready). */
  init(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      this.cache = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
    } catch {
      this.cache = DEFAULT_SETTINGS
    }
  }

  get(): Settings {
    return this.cache
  }

  registerIpc(): void {
    ipcMain.handle(IPC.settingsLoad, () => this.cache)
    ipcMain.handle(IPC.settingsSave, async (_e, settings: Settings) => {
      this.cache = { ...DEFAULT_SETTINGS, ...settings }
      // Atomic write (temp + rename) so a mid-write crash can't corrupt settings.json.
      const tmp = `${this.filePath}.tmp`
      await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), 'utf-8')
      await fs.rename(tmp, this.filePath)
    })
  }
}
