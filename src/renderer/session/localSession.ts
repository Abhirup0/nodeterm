import { createSession, setActiveSession, type WorkspaceSession } from './session'

/** The single local session: its api is the preload object by identity. Built once at boot.
 *
 *  Reading `window.nodeTerminal` at module load time is safe ONLY because of the boot order in
 *  main.tsx: on desktop the preload defines it before any renderer script runs, and on the Server
 *  Edition main.tsx installs the WS bridge and only then `await import('./boot')` — and boot is
 *  the only importer of App (which imports this module). A static import of App from main.tsx
 *  would hoist this line ahead of the bridge install and silently capture `undefined` by identity
 *  in the browser. Keep the dynamic import. */
export const localSession: WorkspaceSession = createSession('local', window.nodeTerminal, 'This Mac')
setActiveSession(localSession.id)
