import { create } from 'zustand'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

interface SettingsState {
  settings: Settings
  hydrate(): Promise<void>
  update(patch: Partial<Settings>): void
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,

  async hydrate() {
    const s = await window.nodeTerminal.settings.load()
    set({ settings: { ...DEFAULT_SETTINGS, ...s } })
  },

  update(patch) {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    void window.nodeTerminal.settings.save(next)
  }
}))
