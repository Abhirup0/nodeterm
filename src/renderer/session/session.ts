import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { NodeTerminalApi } from '@shared/types'
import { createPresenceSession, defaultPresence, type PresenceSession } from '../state/presence'

// Placeholder store-instance type. Task 4 replaces `AgentStatusSession` with the real
// per-session agent-status store type (`../state/agentStatus`) — that store is not a
// per-instance factory yet, so importing it here would be wrong. Deliberately not exported:
// nothing may depend on the placeholder shape.
// BRANDED on purpose: a bare `object` would accept a real store, so wiring one into
// `buildStores()` while forgetting to swap the alias would typecheck cleanly and leave the
// slot typed as a placeholder forever. The unique-symbol brand makes that assignment a compile
// error at the exact line — replacing the alias is the only way to satisfy the compiler.
declare const PLACEHOLDER: unique symbol
/** Task 4 replaces this with the real per-session agent-status store type. */
type AgentStatusSession = { readonly [PLACEHOLDER]: 'replace in Task 4' }

export type SessionSource = 'local' | 'relay' | 'server'

/** A connection to one core plus that core's API. Every project tab belongs to a session.
 *  For the local session `api` IS window.nodeTerminal — the same function references used today. */
export interface WorkspaceSession {
  id: string
  source: SessionSource
  label: string
  api: NodeTerminalApi
  status: 'connected' | 'connecting' | 'offline'
}

/** The per-session renderer store instances (the multiplayer tables that must not be shared
 *  across sessions). Held in the registry beside the session, addressable by session id. */
export interface SessionStores {
  presence: PresenceSession
  agentStatus: AgentStatusSession
}

interface Entry {
  session: WorkspaceSession
  stores: SessionStores
}

const SESSIONS = new Map<string, Entry>()
let activeId: string | null = null
let remoteSeq = 0

/** The per-session store instances. The LOCAL session reuses the module's default presence
 *  instance — the exact object the ~40 historical `state/presence` imports resolve to — so
 *  there is ONE local presence store, never a parallel twin whose connect() would race the
 *  default's subscription for the bridge's first-subscriber replay buffer. A remote session
 *  gets a fresh instance bound to ITS api (a different core, a different peer-id space).
 *  Task 4 replaces the agentStatus placeholder with the real default instance. */
function buildStores(source: SessionSource, api: NodeTerminalApi): SessionStores {
  return {
    presence: source === 'local' ? defaultPresence : createPresenceSession(api),
    agentStatus: {} as AgentStatusSession
  }
}

/** Idempotent per id: if the id already exists, the EXISTING session is returned and nothing is
 *  rebuilt. After Task 2 `buildStores()` constructs a real presence store with a live
 *  subscription — a duplicate call (hot reload, a test helper, a future reconnect path) must not
 *  build a second one beside the first (Stage 1's "exactly one subscriber" invariant is per
 *  session). Return-existing rather than throw: the duplicate caller wants "the session for this
 *  id", and throwing would turn a benign HMR re-run of localSession.ts into a renderer crash. */
export function createSession(source: SessionSource, api: NodeTerminalApi, label: string): WorkspaceSession {
  const id = source === 'local' ? 'local' : `${source}-${++remoteSeq}`
  const existing = SESSIONS.get(id)
  if (existing) return existing.session
  const session: WorkspaceSession = { id, source, label, api, status: 'connected' }
  SESSIONS.set(id, { session, stores: buildStores(source, api) })
  return session
}

/** Test-only: clears the registry so each test starts with no sessions. */
export function resetSessionsForTest(): void {
  SESSIONS.clear()
  activeId = null
  remoteSeq = 0
}

export function getSessionStores(sessionId: string): SessionStores {
  const e = SESSIONS.get(sessionId)
  if (!e) throw new Error(`[session] no session ${sessionId}`)
  return e.stores
}

export function setActiveSession(sessionId: string): void {
  if (!SESSIONS.has(sessionId)) throw new Error(`[session] no session ${sessionId}`)
  activeId = sessionId
}

export function getActiveSession(): WorkspaceSession {
  if (!activeId) throw new Error('[session] no active session')
  return SESSIONS.get(activeId)!.session
}

export function activeSessionApi(): NodeTerminalApi {
  return getActiveSession().api
}

export const SessionContext = createContext<WorkspaceSession | null>(null)

export function useSession(): WorkspaceSession {
  const s = useContext(SessionContext)
  if (!s) throw new Error('[session] useSession() outside a SessionProvider')
  return s
}

export function useSessionStores(): SessionStores {
  return getSessionStores(useSession().id)
}

export function SessionProvider({ session, children }: { session: WorkspaceSession; children: ReactNode }) {
  return createElement(SessionContext.Provider, { value: session }, children)
}
