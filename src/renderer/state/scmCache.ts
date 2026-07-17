import { create } from 'zustand'
import type { GitStatus } from '@shared/types'
import type { GitHistoryResult } from '@shared/git-history'

/**
 * Last-known Source Control data per repo cwd, so reopening the panel paints instantly.
 *
 * The panel is mounted per open (`scOpen` in Canvas) and used to hold status/history in
 * component-local useState — every close threw the data away and every reopen showed an empty
 * drawer until a fresh `git.status` + `git.history` round-trip completed. This store is the
 * same pattern as `scmDraft`: keyed by cwd (an SSH project's remoteCwd included), written
 * through on every refresh, and read as the initial paint on mount while the panel's normal
 * refresh-on-mount silently replaces it. Renderer-session-lifetime only — nothing is persisted.
 */
interface ScmCacheState {
  status: Record<string, GitStatus>
  history: Record<string, GitHistoryResult>
  setStatus(cwd: string, status: GitStatus): void
  setHistory(cwd: string, history: GitHistoryResult): void
}

export const useScmCache = create<ScmCacheState>((set) => ({
  status: {},
  history: {},
  setStatus(cwd, status) {
    if (!cwd) return
    set((s) => ({ status: { ...s.status, [cwd]: status } }))
  },
  setHistory(cwd, history) {
    if (!cwd) return
    set((s) => ({ history: { ...s.history, [cwd]: history } }))
  }
}))
