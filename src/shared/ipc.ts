// IPC channel names — single source of truth for both main and preload.

export const IPC = {
  ptyCreate: 'pty:create',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyDestroy: 'pty:destroy',
  // Events broadcast from main to the renderer (sessionId is appended to the channel name).
  ptyData: (sessionId: string) => `pty:data:${sessionId}`,
  ptyExit: (sessionId: string) => `pty:exit:${sessionId}`,
  workspaceLoad: 'workspace:load',
  workspaceSave: 'workspace:save',
  dialogSelectFolder: 'dialog:select-folder',
  settingsLoad: 'settings:load',
  settingsSave: 'settings:save',
  gitStatus: 'git:status',
  gitInit: 'git:init',
  gitCommit: 'git:commit',
  gitPush: 'git:push',
  gitPull: 'git:pull',
  gitSync: 'git:sync',
  gitPublish: 'git:publish',
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  gitStageAll: 'git:stage-all',
  gitUnstageAll: 'git:unstage-all',
  gitDiff: 'git:diff',
  gitDiscard: 'git:discard',
  gitSwitchBranch: 'git:switch-branch',
  gitCreateBranch: 'git:create-branch',
  commitGenerate: 'commit:generate'
} as const
