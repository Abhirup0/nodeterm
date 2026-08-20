// S6 PR 8 — the discovered identity of the SYSTEM Codex account (`~/.codex`), per machine.
// Based on @Corvin's #112 (`src/renderer/state/systemCodexAccount.ts`).
//
// The system account is implicit (no CodexAccount record), so its email is resolved lazily and
// once per machine: `ensure()` for this Mac, `ensureRemote(host, projectId)` for a connected SSH
// host. Every read is fail-closed — no login / unreachable host / read error resolves to `null`,
// NEVER a fabricated identity (a machine panel with no discoverable system login shows no email
// rather than borrowing another machine's).

import { create } from 'zustand'

interface SystemCodexAccountState {
  /** This Mac's system Codex login email, or null (unknown / not logged in). */
  email: string | null
  /** Once-guard: the local read fires a single time per app session. */
  loaded: boolean
  /** Per-host system login email; a key present with value null means "read, not logged in". */
  remoteEmails: Record<string, string | null>
  /** Per-host in-flight guard so a host is probed once even while its read is pending. */
  remoteLoading: Record<string, boolean>
  ensure(): void
  ensureRemote(host: string, projectId: string): void
}

export const useSystemCodexAccount = create<SystemCodexAccountState>((set, get) => ({
  email: null,
  loaded: false,
  remoteEmails: {},
  remoteLoading: {},
  ensure() {
    if (get().loaded) return
    set({ loaded: true })
    void window.nodeTerminal.codexAccounts
      .systemIdentity()
      .then((identity) => set({ email: identity?.email ?? null }))
      .catch(() => {})
  },
  ensureRemote(host, projectId) {
    // Once per host: skip if a read is in flight OR already completed (even to a null email — a
    // resolved "not logged in" must not re-trigger a probe every render).
    if (get().remoteLoading[host] || Object.hasOwn(get().remoteEmails, host)) return
    set((state) => ({
      remoteLoading: { ...state.remoteLoading, [host]: true }
    }))
    void window.nodeTerminal.codexAccounts
      .systemIdentity({ projectId })
      .then((identity) =>
        set((state) => ({
          remoteEmails: {
            ...state.remoteEmails,
            [host]: identity?.email ?? null
          },
          remoteLoading: { ...state.remoteLoading, [host]: false }
        }))
      )
      .catch(() =>
        set((state) => ({
          remoteLoading: { ...state.remoteLoading, [host]: false }
        }))
      )
  }
}))
