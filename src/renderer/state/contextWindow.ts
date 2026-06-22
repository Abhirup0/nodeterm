import { create } from 'zustand'
import type { ContextWindowUsage } from '@shared/types'

// Per-session context-window fill, fed by context.onUpdate.
//
// Persisted to localStorage (like agentStatus' sessionId). Why: after an app restart the
// node's sessionId is restored, but its tmux Claude session is now idle and emits no new
// hook event — so the main-process tailer is never re-fed the transcript path and can't
// re-push until the next prompt. Without persistence the meter would vanish on every restart
// even though the session (and its fill) is unchanged. We restore the last-known value so the
// meter survives the restart; the live tailer overwrites it on the next prompt.
const KEY = 'nodeterm.contextWindow'

function load(): Record<string, ContextWindowUsage> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const data = JSON.parse(raw) as Record<string, ContextWindowUsage>
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function save(bySessionId: Record<string, ContextWindowUsage>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(bySessionId))
  } catch {
    // ignore quota / serialization errors
  }
}

interface ContextWindowState {
  bySessionId: Record<string, ContextWindowUsage>
  set(usage: ContextWindowUsage): void
}

export const useContextWindow = create<ContextWindowState>((set) => ({
  bySessionId: load(),
  set: (usage) =>
    set((s) => {
      const bySessionId = { ...s.bySessionId, [usage.sessionId]: usage }
      save(bySessionId)
      return { bySessionId }
    })
}))
