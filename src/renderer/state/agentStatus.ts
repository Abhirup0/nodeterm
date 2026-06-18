import { create } from 'zustand'
import type { AgentId } from '@shared/agents/config'
import type { AgentState } from '@shared/agents/normalize'

/**
 * Transient per-node status for agent (e.g. Claude Code) sessions, driven by the agent's hooks.
 * `unread`, `session` and `sessionId` are persisted to localStorage so they survive a
 * reload/restart; the live `state` (working/waiting/…) is not (it'd be stale on relaunch).
 */
export interface AgentNodeStatus {
  /** Live activity; undefined = idle/unknown. */
  state?: AgentState
  /** Which agent this node is running (claude/codex/gemini/…), when known. */
  agentId?: AgentId
  /** A turn finished / needs attention while the user wasn't looking. */
  unread: boolean
  /** Claude's own session name/title (from the terminal title), shown beside the title. */
  session?: string
  /** Claude session id (from hooks) — used to resume/branch the conversation. */
  sessionId?: string
  /** Set when running /loop, /schedule or /cron (heuristic); shown as a connected node. */
  loop?: {
    count: number
    kind: 'loop' | 'schedule' | 'cron'
    /** Schedule expression (cron) shown as a sub-label. */
    schedule?: string
    /** The task/prompt — shown in full and re-issued by the node's Play button. */
    task?: string
    /** Per-iteration summaries (in-session /loop). */
    items: string[]
  }
}

interface AgentStatusStore {
  byId: Record<string, AgentNodeStatus>
  /** The terminal node the user is currently focused in (for unread decisions). */
  activeId: string | null
  setActive(id: string, active: boolean): void
  setState(id: string, state: AgentState | undefined, agentId?: AgentId): void
  setSession(id: string, session: string): void
  setSessionId(id: string, sessionId: string): void
  markUnread(id: string): void
  clearUnread(id: string): void
  /** Start (active=true, resets) or stop a /loop, /schedule or /cron indicator. */
  setLoop(
    id: string,
    active: boolean,
    kind?: 'loop' | 'schedule' | 'cron',
    opts?: { schedule?: string; task?: string }
  ): void
  /** Record a /loop iteration (count++ and append its summary). No-op if not looping. */
  bumpLoop(id: string, message?: string): void
  remove(id: string): void
}

const EMPTY: AgentNodeStatus = { unread: false }
const KEY = 'nodeterm.agentStatus'

// One-time localStorage migration from the old key. Runs before the store hydrates.
const LEGACY_KEY = 'nodeterm.claudeStatus'
try {
  if (!localStorage.getItem(KEY)) {
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy) localStorage.setItem(KEY, legacy)
  }
} catch {
  /* ignore */
}

function load(): Record<string, AgentNodeStatus> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const data = JSON.parse(raw) as Record<string, Partial<AgentNodeStatus>>
    const out: Record<string, AgentNodeStatus> = {}
    for (const [id, v] of Object.entries(data)) {
      out[id] = { unread: !!v.unread, session: v.session, sessionId: v.sessionId }
    }
    return out
  } catch {
    return {}
  }
}

// Persist only the durable fields (not the live `state`).
function save(byId: Record<string, AgentNodeStatus>): void {
  try {
    const out: Record<string, Partial<AgentNodeStatus>> = {}
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

export const useAgentStatus = create<AgentStatusStore>((set) => ({
  byId: load(),
  activeId: null,

  setActive: (id, active) =>
    set((s) => {
      if (active) return s.activeId === id ? s : { activeId: id }
      return s.activeId === id ? { activeId: null } : s
    }),

  setState: (id, state, agentId) =>
    set((s) => {
      const prev = s.byId[id] ?? EMPTY
      if (prev.state === state && (agentId === undefined || prev.agentId === agentId)) return s
      const next = { ...prev, state }
      if (agentId !== undefined) next.agentId = agentId
      return { byId: { ...s.byId, [id]: next } }
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

  setLoop: (id, active, kind = 'loop', opts) =>
    set((s) => {
      const prev = s.byId[id] ?? EMPTY
      if (active)
        return {
          byId: {
            ...s.byId,
            [id]: { ...prev, loop: { count: 0, kind, schedule: opts?.schedule, task: opts?.task, items: [] } }
          }
        }
      if (!prev.loop) return s
      const { loop: _drop, ...rest } = prev
      return { byId: { ...s.byId, [id]: rest } }
    }),

  bumpLoop: (id, message) =>
    set((s) => {
      const prev = s.byId[id]
      // Only count in-session /loop turns; /schedule and /cron run in the background.
      if (!prev?.loop || prev.loop.kind !== 'loop') return s
      const items = message
        ? [...prev.loop.items, message.trim().slice(0, 4000)].slice(-100)
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
