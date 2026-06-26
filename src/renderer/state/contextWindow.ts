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
// Hard cap on retained sessions. Every resume / `/clear` / restart mints a new sessionId, so
// without a bound the map would grow forever (and we'd re-stringify the whole thing on every
// hook tick). 200 is far more than any realistic number of live meters; oldest are evicted.
const MAX_SESSIONS = 200
// Don't write localStorage on every update (onUpdate fires repeatedly within a turn); coalesce.
const SAVE_DEBOUNCE_MS = 2000

function load(): Record<string, ContextWindowUsage> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const data = JSON.parse(raw) as Record<string, ContextWindowUsage>
    return data && typeof data === 'object' ? prune(data) : {}
  } catch {
    return {}
  }
}

/** Keep only the MAX_SESSIONS most-recently-updated entries (LRU by updatedAt). */
function prune(map: Record<string, ContextWindowUsage>): Record<string, ContextWindowUsage> {
  const keys = Object.keys(map)
  if (keys.length <= MAX_SESSIONS) return map
  const newest = keys
    .sort((a, b) => (map[b]?.updatedAt ?? 0) - (map[a]?.updatedAt ?? 0))
    .slice(0, MAX_SESSIONS)
  const out: Record<string, ContextWindowUsage> = {}
  for (const k of newest) out[k] = map[k]
  return out
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(bySessionId: Record<string, ContextWindowUsage>): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      localStorage.setItem(KEY, JSON.stringify(bySessionId))
    } catch {
      // ignore quota / serialization errors
    }
  }, SAVE_DEBOUNCE_MS)
}

interface ContextWindowState {
  bySessionId: Record<string, ContextWindowUsage>
  set(usage: ContextWindowUsage): void
}

export const useContextWindow = create<ContextWindowState>((set) => ({
  bySessionId: load(),
  set: (usage) =>
    set((s) => {
      const merged = { ...s.bySessionId, [usage.sessionId]: usage }
      const bySessionId = prune(merged)
      scheduleSave(bySessionId)
      return { bySessionId }
    })
}))
