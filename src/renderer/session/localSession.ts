import { createSession, setActiveSession, type WorkspaceSession } from './session'

/** The single local session: its api is the preload object by identity. Built once at boot. */
export const localSession: WorkspaceSession = createSession('local', window.nodeTerminal, 'This Mac')
setActiveSession(localSession.id)
