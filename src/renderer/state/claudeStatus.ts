import { create } from 'zustand'

/**
 * Transient per-node status for Claude Code sessions, driven by Claude's hooks.
 * `unread`, `session` and `sessionId` are persisted to localStorage so they survive a
 * reload/restart; the live `state` (working/waiting/…) is not (it'd be stale on relaunch).
 */
export type ClaudeState = 'working' | 'waiting' | 'blocked' | 'done'

export interface ClaudeNodeStatus {
  /** Live activity; undefined = idle/unknown. */
  state?: ClaudeState
  /** A turn finished / needs attention while the user wasn't looking. */
  unread: boolean
  /** Claude's own session name/title (from the terminal title), shown beside the title. */
  session?: string
  /** Claude session id (from hooks) — used to resume/branch the conversation. */
  sessionId?: string
  /** Set when running /loop, /schedule or /cron (heuristic); shown as a connected node. */
  loop?: { count: number; prompt?: string; items: string[]; kind: 'loop' | 'schedule' | 'cron' }
}

interface ClaudeStatusState {
  byId: Record<string, ClaudeNodeStatus>
  /** The terminal node the user is currently focused in (for unread decisions). */
  activeId: string | null
  setActive(id: string, active: boolean): void
  setState(id: string, state: ClaudeState | undefined): void
  setSession(id: string, session: string): void
  setSessionId(id: string, sessionId: string): void
  markUnread(id: string): void
  clearUnread(id: string): void
  /** Start (active=true, resets) or stop a /loop, /schedule or /cron indicator. */
  setLoop(id: string, active: boolean, kind?: 'loop' | 'schedule' | 'cron', prompt?: string): void
  /** Record a /loop iteration (count++ and append its summary). No-op if not looping. */
  bumpLoop(id: string, message?: string): void
  remove(id: string): void
}

const EMPTY: ClaudeNodeStatus = { unread: false }
const KEY = 'nodeterm.claudeStatus'

function load(): Record<string, ClaudeNodeStatus> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const data = JSON.parse(raw) as Record<string, Partial<ClaudeNodeStatus>>
    const out: Record<string, ClaudeNodeStatus> = {}
    for (const [id, v] of Object.entries(data)) {
      out[id] = { unread: !!v.unread, session: v.session, sessionId: v.sessionId }
    }
    return out
  } catch {
    return {}
  }
}

// Persist only the durable fields (not the live `state`).
function save(byId: Record<string, ClaudeNodeStatus>): void {
  try {
    const out: Record<string, Partial<ClaudeNodeStatus>> = {}
    for (const [id, v] of Object.entries(byId)) {
      if (v.unread || v.session || v.sessionId) {
        out[id] = { unread: v.unread, session: v.session, sessionId: v.sessionId }
      }
    }
    localStorage.setItem(KEY, JSON.stringify(out))
  } catch {
    // ignore quota / serialization errors
  }
}

export const useClaudeStatus = create<ClaudeStatusState>((set) => ({
  byId: load(),
  activeId: null,

  setActive: (id, active) =>
    set((s) => {
      if (active) return s.activeId === id ? s : { activeId: id }
      return s.activeId === id ? { activeId: null } : s
    }),

  setState: (id, state) =>
    set((s) => {
      const prev = s.byId[id] ?? EMPTY
      if (prev.state === state) return s
      return { byId: { ...s.byId, [id]: { ...prev, state } } }
    }),

  setSession: (id, session) =>
    set((s) => {
      const prev = s.byId[id] ?? EMPTY
      if (prev.session === session) return s
      const byId = { ...s.byId, [id]: { ...prev, session } }
      save(byId)
      return { byId }
    }),

  setSessionId: (id, sessionId) =>
    set((s) => {
      const prev = s.byId[id] ?? EMPTY
      if (prev.sessionId === sessionId) return s
      const byId = { ...s.byId, [id]: { ...prev, sessionId } }
      save(byId)
      return { byId }
    }),

  markUnread: (id) =>
    set((s) => {
      const prev = s.byId[id] ?? EMPTY
      if (prev.unread) return s
      const byId = { ...s.byId, [id]: { ...prev, unread: true } }
      save(byId)
      return { byId }
    }),

  clearUnread: (id) =>
    set((s) => {
      const prev = s.byId[id]
      if (!prev?.unread) return s
      const byId = { ...s.byId, [id]: { ...prev, unread: false } }
      save(byId)
      return { byId }
    }),

  setLoop: (id, active, kind = 'loop', prompt) =>
    set((s) => {
      const prev = s.byId[id] ?? EMPTY
      if (active)
        return { byId: { ...s.byId, [id]: { ...prev, loop: { count: 0, prompt, items: [], kind } } } }
      if (!prev.loop) return s
      const { loop: _drop, ...rest } = prev
      return { byId: { ...s.byId, [id]: rest } }
    }),

  bumpLoop: (id, message) =>
    set((s) => {
      const prev = s.byId[id]
      if (!prev?.loop) return s
      const items = message
        ? [...prev.loop.items, message.replace(/\s+/g, ' ').trim().slice(0, 200)].slice(-50)
        : prev.loop.items
      return {
        byId: { ...s.byId, [id]: { ...prev, loop: { ...prev.loop, count: prev.loop.count + 1, items } } }
      }
    }),

  remove: (id) =>
    set((s) => {
      if (!(id in s.byId)) return s
      const byId = { ...s.byId }
      delete byId[id]
      save(byId)
      return { byId }
    })
}))
