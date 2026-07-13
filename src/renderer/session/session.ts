import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { NodeTerminalApi } from '@shared/types'

// Placeholder store-instance types. Task 2 replaces `PresenceSession` with the real per-session
// presence store type (`../state/presence`) and Task 4 does the same for `AgentStatusSession`
// (`../state/agentStatus`) — those stores are not per-instance factories yet, so importing them
// here would be wrong. Deliberately not exported: nothing may depend on the placeholder shape.
type PresenceSession = object
type AgentStatusSession = object

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

/** Task 2/4 replace this with the real default instances for the local session. Until then a
 *  minimal placeholder keeps the registry shape honest without pulling in the stores. */
function buildStores(): SessionStores {
  return { presence: {}, agentStatus: {} }
}

export function createSession(source: SessionSource, api: NodeTerminalApi, label: string): WorkspaceSession {
  const id = source === 'local' ? 'local' : `${source}-${++remoteSeq}`
  const session: WorkspaceSession = { id, source, label, api, status: 'connected' }
  SESSIONS.set(id, { session, stores: buildStores() })
  return session
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
