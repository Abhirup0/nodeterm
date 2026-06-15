// IPC channel names — single source of truth for both main and preload.

export const IPC = {
  ptyCreate: 'pty:create',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  // Events broadcast from main to the renderer (sessionId is appended to the channel name).
  ptyData: (sessionId: string) => `pty:data:${sessionId}`,
  ptyExit: (sessionId: string) => `pty:exit:${sessionId}`,
  workspaceLoad: 'workspace:load',
  workspaceSave: 'workspace:save'
} as const
