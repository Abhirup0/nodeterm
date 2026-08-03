import { promises as fs, readFileSync } from 'fs'
import path from 'path'
import { IPC } from '../shared/ipc'
import { platform } from './platform'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

/**
 * Merge a possibly-partial/legacy `Settings` object over `DEFAULT_SETTINGS`. A plain
 * `{ ...DEFAULT_SETTINGS, ...saved }` shallow merge is right for top-level keys (a missing key
 * picks up the default), but WRONG for nested objects: an old `settings.json` that has a
 * `speech` object without a newly-added key (e.g. `shortcut`) would have its whole `speech`
 * object override the default one-for-one, silently dropping the new key. `speech` is merged
 * one level deeper so old files still pick up new nested defaults.
 */
function mergeSettings(saved: Partial<Settings> | null | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...saved }
  merged.speech = { ...DEFAULT_SETTINGS.speech, ...saved?.speech }
  // Legacy `terminalGpuRendering` was a boolean whose default (true) was merged into every saved
  // file — so a stored `true` is indistinguishable from "never touched" and maps to the new
  // 'auto' (platform-aware) default, while a stored `false` was always an explicit escape-hatch
  // choice and stays 'off'. See the field's doc in shared/types.ts.
  const gpu = (saved as { terminalGpuRendering?: unknown } | null | undefined)
    ?.terminalGpuRendering
  if (gpu === false) merged.terminalGpuRendering = 'off'
  else if (gpu !== 'on' && gpu !== 'off' && gpu !== 'auto') merged.terminalGpuRendering = 'auto'
  return merged
}

/**
 * Stores user settings in settings.json. Keeps a synchronous cache so the PtyManager
 * can read shell/tmux preferences immediately at terminal creation.
 */
export class SettingsStore {
  private cache: Settings = DEFAULT_SETTINGS
  private listeners = new Set<(s: Settings) => void>()

  private get filePath(): string {
    return path.join(platform().userDataDir, 'settings.json')
  }

  /** Subscribe to saves (fires after each successful `settings:save`). Additive; used by the
   *  desktop shell to create/destroy runtime-toggled subsystems (e.g. the Notch HUD). Returns an
   *  unsubscribe. Never throws into a save. */
  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Load synchronously into cache (call after app is ready). */
  init(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      this.cache = mergeSettings(JSON.parse(raw))
    } catch {
      this.cache = DEFAULT_SETTINGS
    }
  }

  get(): Settings {
    return this.cache
  }

  registerIpc(): void {
    platform().handle(IPC.settingsLoad, () => this.cache)
    platform().handle(IPC.settingsSave, async (settings: Settings) => {
      this.cache = mergeSettings(settings)
      // Atomic write (temp + rename) so a mid-write crash can't corrupt settings.json.
      const tmp = `${this.filePath}.tmp`
      await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), 'utf-8')
      await fs.rename(tmp, this.filePath)
      for (const cb of this.listeners) {
        try {
          cb(this.cache)
        } catch {
          // A listener must never break a settings save (or its siblings).
        }
      }
    })
  }
}
