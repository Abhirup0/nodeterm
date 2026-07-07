import { create } from 'zustand'

/**
 * Detected identity of the SYSTEM Claude account (the machine's default `~/.claude` login).
 * Managed accounts carry their captured email in settings, but the system account is implicit
 * (no ClaudeAccount record), so its email is resolved lazily from the usage endpoint's cached
 * credential lookup in main. Pickers/settings show it next to "System account" so it stays
 * distinguishable once managed accounts exist. Fail-open: no login / no network → null.
 */
interface SystemAccountState {
  email: string | null
  /** Guard so the lazy fetch runs once per app session (main caches the underlying lookup). */
  loaded: boolean
  ensure(): void
}

export const useSystemAccount = create<SystemAccountState>((set, get) => ({
  email: null,
  loaded: false,
  ensure() {
    if (get().loaded) return
    set({ loaded: true })
    void window.nodeTerminal.usage
      .fetch()
      .then((u) => set({ email: u?.email ?? null }))
      .catch(() => {})
  }
}))
