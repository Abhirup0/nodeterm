import { create } from 'zustand'

/**
 * Transient per-node status for Claude Code terminals — busy/working, unread, and the
 * Claude session name. Deliberately NOT persisted (kept out of workspace.json); it resets
 * on reload / project switch, which is the desired "clean layout file" behavior.
 */
export interface ClaudeNodeStatus {
  /** Claude is actively processing a turn. */
  busy: boolean
  /** A turn finished while the user wasn't looking; cleared on focus/select. */
  unread: boolean
  /** Claude's own session name/title (from the terminal title), shown beside the title. */
  session?: string
  /** Claude session id (UUID from hooks) — used to resume/branch the conversation. */
  sessionId?: string
  /** Timestamp of the last busy→idle transition. */
  finishedAt?: number
}

interface ClaudeStatusState {
  byId: Record<string, ClaudeNodeStatus>
  setBusy(id: string, busy: boolean): void
  setSession(id: string, session: string): void
  setSessionId(id: string, sessionId: string): void
  markUnread(id: string): void
  clearUnread(id: string): void
  remove(id: string): void
}

const EMPTY: ClaudeNodeStatus = { busy: false, unread: false }

export const useClaudeStatus = create<ClaudeStatusState>((set) => ({
  byId: {},

  setBusy: (id, busy) =>
    set((s) => {
      const prev = s.byId[id] ?? EMPTY
      if (prev.busy === busy) return s
      return {
        byId: {
          ...s.byId,
          [id]: { ...prev, busy, finishedAt: busy ? prev.finishedAt : Date.now() }
        }
      }
    }),

  setSession: (id, session) =>
    set((s) => {
      const prev = s.byId[id] ?? EMPTY
      if (prev.session === session) return s
      return { byId: { ...s.byId, [id]: { ...prev, session } } }
    }),

  setSessionId: (id, sessionId) =>
    set((s) => {
      const prev = s.byId[id] ?? EMPTY
      if (prev.sessionId === sessionId) return s
      return { byId: { ...s.byId, [id]: { ...prev, sessionId } } }
    }),

  markUnread: (id) =>
    set((s) => {
      const prev = s.byId[id] ?? EMPTY
      if (prev.unread) return s
      return { byId: { ...s.byId, [id]: { ...prev, unread: true } } }
    }),

  clearUnread: (id) =>
    set((s) => {
      const prev = s.byId[id]
      if (!prev?.unread) return s
      return { byId: { ...s.byId, [id]: { ...prev, unread: false } } }
    }),

  remove: (id) =>
    set((s) => {
      if (!(id in s.byId)) return s
      const next = { ...s.byId }
      delete next[id]
      return { byId: next }
    })
}))
