import { create } from 'zustand'
import type { ContextWindowUsage } from '@shared/types'

// Transient (not persisted): per-session context-window fill, fed by context.onUpdate.
interface ContextWindowState {
  bySessionId: Record<string, ContextWindowUsage>
  set(usage: ContextWindowUsage): void
}

export const useContextWindow = create<ContextWindowState>((set) => ({
  bySessionId: {},
  set: (usage) =>
    set((s) => ({ bySessionId: { ...s.bySessionId, [usage.sessionId]: usage } }))
}))
