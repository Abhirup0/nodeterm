import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { AgentId } from '@shared/agents/config'
import type { AgentState } from '@shared/agents/normalize'
import type { NodeTerminalApi } from '@shared/types'

/**
 * Transient per-node status for agent (e.g. Claude Code) sessions, driven by the agent's hooks.
 * `unread`, `session` and `sessionId` are persisted to localStorage so they survive a
 * reload/restart; the live `state` (working/waiting/…) is not (it'd be stale on relaunch).
 *
 * ONE STORE PER CORE (stage 4): `createAgentStatusSession(persistKey?)` builds an isolated
 * instance — node ids are per-core, so status tables from two cores must never mix. The module
 * keeps a DEFAULT instance for the local core and re-exports its members under the historical
 * names, so the existing single-session consumers are untouched. The session registry resolves
 * a store through `agentStatusForApi(api)` — memoized BY API IDENTITY like presence, and seeded
 * with `window.nodeTerminal → defaultAgentStatus`, so the local session (and any path handed a
 * repeat api) structurally gets the one existing store, never a parallel twin.
 *
 * PERSISTENCE IS PER-KEY, AND ONLY THE DEFAULT HAS ONE. This is deliberately the opposite call
 * from presence's shared ME_KEY: {name, color} is who the HUMAN is (one per person, shared
 * across sessions), but agent status is per-NODE state on a SPECIFIC core — a remote core's
 * unread/sessionId for `nt-x` is not this machine's `nt-x` (tmux persistKeys are unique within
 * one core only), and `save()` rewrites the WHOLE table, so a remote session sharing
 * `nodeterm.agentStatus` would clobber the local nodes' persisted unread/session/loop on its
 * first write. So: the default instance keeps the historical key (bit-for-bit today's
 * behavior, legacy migration included); a keyless instance persists NOTHING (remote status is
 * rebuilt from the remote core's hooks on reconnect — a durable per-remote key needs a stable
 * session identity, which sub-stage 4c owns); the `persistKey` parameter is how 4c opts a
 * session into its own namespaced key without touching this file.
 */
export interface AgentNodeStatus {
  /** Live activity; undefined = idle/unknown. */
  state?: AgentState
  /**
   * When the LAST hook event asserted the current state (freshness, not transition time).
   * Never rendered — drives the done-holdoff guard, the stale-working sweeper, and the
   * interrupt-inference baseline. Same-state events refresh it in place (no re-render).
   */
  stateAt?: number
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

export interface AgentStatusStore {
  byId: Record<string, AgentNodeStatus>
  /** The terminal node the user is currently focused in (for unread decisions). */
  activeId: string | null
  setActive(id: string, active: boolean): void
  /** `newTurn` marks a genuine UserPromptSubmit — the only working that may follow a fresh done. */
  setState(id: string, state: AgentState | undefined, agentId?: AgentId, newTurn?: boolean): void
  /** Clear `working` entries whose last event is older than `staleMs` (lost-Stop safety net). */
  sweepStaleWorking(staleMs?: number): void
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
/** The DEFAULT (local-core) persistence key. Only the default instance uses it. */
const KEY = 'nodeterm.agentStatus'
const LEGACY_KEY = 'nodeterm.claudeStatus'

// Claude Code runs hooks in PARALLEL, so the last PostToolUse's POST can arrive after the
// Stop's POST — hold done against any non-newTurn working for this long.
export const DONE_HOLDOFF_MS = 3000
// Last-resort net for a lost Stop POST / crashed CLI: a working entry that saw no event at
// all for this long decays to idle. Long on purpose:
// a single silent tool run (e.g. a long build) fires no hooks between Pre- and PostToolUse,
// so anything shorter would flip genuinely-running turns to idle.
export const STALE_WORKING_MS = 30 * 60_000
// Esc/Ctrl-C interrupt inference: how long to wait for a hook event before concluding the
// turn was cancelled without a final Stop.
export const INTERRUPT_SETTLE_MS = 1500

/** One-time localStorage migration from the old key. Runs before the default store hydrates —
 *  and ONLY for the default key: a namespaced or keyless instance must never adopt legacy data
 *  that belongs to the local core. */
function migrateLegacyKey(): void {
  try {
    if (!localStorage.getItem(KEY)) {
      const legacy = localStorage.getItem(LEGACY_KEY)
      if (legacy) localStorage.setItem(KEY, legacy)
    }
  } catch {
    /* ignore */
  }
}

/** One session's agent status: its store plus the interrupt-inference helper bound to it. */
export interface AgentStatusSession {
  store: UseBoundStore<StoreApi<AgentStatusStore>>
  /**
   * Esc/Ctrl-C interrupt inference: Claude Code fires NO hook when the user
   * cancels a turn, so a node interrupted mid-work would sit on "working" forever. Called
   * from the terminal's input path on a lone Esc / Ctrl-C: wait one settle window; if the
   * node is still `working` and NOT ONE hook event arrived since the keystroke (stateAt
   * unchanged), conclude the turn was cancelled and flip it to done. A wrong guess
   * self-corrects: the next real hook event sets working again (it's past the holdoff).
   */
  inferInterruptAfterSettle(id: string, settleMs?: number): void
}

/**
 * Build the agent-status store for ONE core. `persistKey` is the localStorage key this
 * instance hydrates from and saves to; `undefined` = in-memory only (load returns nothing,
 * save is a no-op — the instance never touches localStorage). See the module docblock for
 * why only the default instance has a key today.
 */
export function createAgentStatusSession(persistKey?: string): AgentStatusSession {
  if (persistKey === KEY) migrateLegacyKey()

  function load(): Record<string, AgentNodeStatus> {
    if (!persistKey) return {}
    try {
      const raw = localStorage.getItem(persistKey)
      if (!raw) return {}
      const data = JSON.parse(raw) as Record<string, Partial<AgentNodeStatus>>
      const out: Record<string, AgentNodeStatus> = {}
      for (const [id, v] of Object.entries(data)) {
        out[id] = { unread: !!v.unread, session: v.session, sessionId: v.sessionId }
        // A recurring job (cron/schedule — and tmux keeps in-session loops alive too) outlives
        // the app: restore its card. Minimal shape check so a corrupt entry can't break load.
        if (v.loop && typeof v.loop === 'object' && v.loop.kind) {
          out[id].loop = {
            count: v.loop.count ?? 0,
            kind: v.loop.kind,
            schedule: v.loop.schedule,
            task: v.loop.task,
            items: Array.isArray(v.loop.items) ? v.loop.items : []
          }
        }
      }
      return out
    } catch {
      return {}
    }
  }

  // Persist only the durable fields (not the live `state`).
  function save(byId: Record<string, AgentNodeStatus>): void {
    if (!persistKey) return
    try {
      const out: Record<string, Partial<AgentNodeStatus>> = {}
      for (const [id, v] of Object.entries(byId)) {
        if (v.unread || v.session || v.sessionId || v.loop) {
          out[id] = { unread: v.unread, session: v.session, sessionId: v.sessionId, loop: v.loop }
        }
      }
      localStorage.setItem(persistKey, JSON.stringify(out))
    } catch {
      // ignore quota / serialization errors
    }
  }

  const store = create<AgentStatusStore>((set) => ({
    byId: load(),
    activeId: null,

    setActive: (id, active) =>
      set((s) => {
        if (active) return s.activeId === id ? s : { activeId: id }
        return s.activeId === id ? { activeId: null } : s
      }),

    setState: (id, state, agentId, newTurn) =>
      set((s) => {
        const prev = s.byId[id] ?? EMPTY
        const now = Date.now()
        // Done-holdoff: a late working event (parallel hook curls arrive out of order, or a
        // tool POST that was in flight when the user interrupted) must not resurrect a turn
        // that just finished. Only a genuine new turn (UserPromptSubmit) may.
        if (
          state === 'working' &&
          !newTurn &&
          prev.state === 'done' &&
          now - (prev.stateAt ?? 0) < DONE_HOLDOFF_MS
        ) {
          return s
        }
        if (prev.state === state && (agentId === undefined || prev.agentId === agentId)) {
          // Same-state event: refresh freshness in place — stateAt is never rendered, and a
          // new object here would re-render every node header on each tool event.
          if (s.byId[id]) s.byId[id].stateAt = now
          return s
        }
        const next = { ...prev, state, stateAt: now }
        if (agentId !== undefined) next.agentId = agentId
        return { byId: { ...s.byId, [id]: next } }
      }),

    sweepStaleWorking: (staleMs = STALE_WORKING_MS) =>
      set((s) => {
        const now = Date.now()
        let changed = false
        const byId = { ...s.byId }
        for (const [id, v] of Object.entries(byId)) {
          if (v.state === 'working' && now - (v.stateAt ?? 0) > staleMs) {
            byId[id] = { ...v, state: undefined, stateAt: now }
            changed = true
          }
        }
        return changed ? { byId } : s
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
        if (active) {
          const byId = {
            ...s.byId,
            [id]: {
              ...prev,
              loop: { count: 0, kind, schedule: opts?.schedule, task: opts?.task, items: [] }
            }
          }
          save(byId)
          return { byId }
        }
        if (!prev.loop) return s
        const { loop: _drop, ...rest } = prev
        const byId = { ...s.byId, [id]: rest }
        save(byId)
        return { byId }
      }),

    bumpLoop: (id, message) =>
      set((s) => {
        const prev = s.byId[id]
        // Only count in-session /loop turns; /schedule and /cron run in the background.
        if (!prev?.loop || prev.loop.kind !== 'loop') return s
        const items = message
          ? [...prev.loop.items, message.trim().slice(0, 4000)].slice(-100)
          : prev.loop.items
        const byId = {
          ...s.byId,
          [id]: { ...prev, loop: { ...prev.loop, count: prev.loop.count + 1, items } }
        }
        save(byId)
        return { byId }
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

  function inferInterruptAfterSettle(id: string, settleMs = INTERRUPT_SETTLE_MS): void {
    const st = store.getState().byId[id]
    if (st?.state !== 'working') return
    const baseline = st.stateAt
    setTimeout(() => {
      const cur = store.getState()
      const now = cur.byId[id]
      if (now?.state === 'working' && now.stateAt === baseline) {
        cur.setState(id, 'done', now.agentId)
      }
    }, settleMs)
  }

  return { store, inferInterruptAfterSettle }
}

/** One instance per api OBJECT — the one-store-per-core guarantee, keyed on identity exactly
 *  like presence's (a WeakMap, so a dropped api never pins its store). Seeded below with
 *  `window.nodeTerminal → defaultAgentStatus`. */
const instanceByApi = new WeakMap<NodeTerminalApi, AgentStatusSession>()

/**
 * The agent-status store for ONE core (one api). MEMOIZED BY API IDENTITY: the session
 * registry resolves its store here, so ANY session handed the local api — the local session
 * itself, a loopback debug session, a test double — shares the default (persisted) instance
 * rather than growing a parallel table the canvas listener isn't driving. A DIFFERENT api (a
 * different core, a different node-id space) gets a fresh KEYLESS instance: a remote core's
 * status must never clobber the local user's persisted unread/session under `KEY` (see the
 * module docblock). A nullish api (node-environment tests) is not memoizable and gets a
 * fresh inert instance.
 */
export function agentStatusForApi(api: NodeTerminalApi): AgentStatusSession {
  const existing = api ? instanceByApi.get(api) : undefined
  if (existing) return existing
  const session = createAgentStatusSession() // keyless — remote status is never persisted (4a)
  if (api) instanceByApi.set(api, session)
  return session
}

/**
 * The DEFAULT instance — the local core's agent status, persisted under the historical key
 * (with the one-time legacy-key migration). Every historical export below resolves to this
 * exact object, so the existing single-session consumers are untouched. Seeding the WeakMap
 * with `window.nodeTerminal` (safe at module load for the boot-order reason documented in
 * localSession.ts; the `typeof window` guard covers node-environment tests) is what makes
 * `agentStatusForApi(window.nodeTerminal)` — the session registry's local session — resolve
 * here, never to a parallel twin.
 */
const defaultAgentStatus = createAgentStatusSession(KEY)
export { defaultAgentStatus }
if (typeof window !== 'undefined' && window.nodeTerminal) {
  instanceByApi.set(window.nodeTerminal as NodeTerminalApi, defaultAgentStatus)
}

export const useAgentStatus = defaultAgentStatus.store
export const inferInterruptAfterSettle = defaultAgentStatus.inferInterruptAfterSettle
