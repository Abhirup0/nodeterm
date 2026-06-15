import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  NodeTerminalApi,
  PtyCreateOptions,
  Workspace
} from '../shared/types'

const api: NodeTerminalApi = {
  pty: {
    create: (options: PtyCreateOptions) => ipcRenderer.invoke(IPC.ptyCreate, options),
    write: (sessionId, data) => ipcRenderer.send(IPC.ptyWrite, sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send(IPC.ptyResize, sessionId, cols, rows),
    kill: (sessionId) => ipcRenderer.send(IPC.ptyKill, sessionId),
    destroy: (persistKey) => ipcRenderer.send(IPC.ptyDestroy, persistKey),
    onData: (sessionId, listener) => {
      const channel = IPC.ptyData(sessionId)
      const handler = (_e: unknown, data: string) => listener(data)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onExit: (sessionId, listener) => {
      const channel = IPC.ptyExit(sessionId)
      const handler = (_e: unknown, code: number) => listener(code)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    }
  },
  workspace: {
    load: () => ipcRenderer.invoke(IPC.workspaceLoad),
    save: (workspace: Workspace) => ipcRenderer.invoke(IPC.workspaceSave, workspace)
  },
  dialog: {
    selectFolder: () => ipcRenderer.invoke(IPC.dialogSelectFolder)
  },
  settings: {
    load: () => ipcRenderer.invoke(IPC.settingsLoad),
    save: (settings) => ipcRenderer.invoke(IPC.settingsSave, settings)
  },
  git: {
    status: (cwd) => ipcRenderer.invoke(IPC.gitStatus, cwd),
    init: (cwd) => ipcRenderer.invoke(IPC.gitInit, cwd),
    commit: (cwd, message) => ipcRenderer.invoke(IPC.gitCommit, cwd, message),
    push: (cwd) => ipcRenderer.invoke(IPC.gitPush, cwd),
    pull: (cwd) => ipcRenderer.invoke(IPC.gitPull, cwd),
    sync: (cwd) => ipcRenderer.invoke(IPC.gitSync, cwd),
    publish: (cwd, name, isPrivate) => ipcRenderer.invoke(IPC.gitPublish, cwd, name, isPrivate),
    stage: (cwd, paths) => ipcRenderer.invoke(IPC.gitStage, cwd, paths),
    unstage: (cwd, paths) => ipcRenderer.invoke(IPC.gitUnstage, cwd, paths),
    stageAll: (cwd) => ipcRenderer.invoke(IPC.gitStageAll, cwd),
    unstageAll: (cwd) => ipcRenderer.invoke(IPC.gitUnstageAll, cwd),
    diff: (cwd, path, staged, untracked) =>
      ipcRenderer.invoke(IPC.gitDiff, cwd, path, staged, untracked),
    discard: (cwd, path, untracked) => ipcRenderer.invoke(IPC.gitDiscard, cwd, path, untracked),
    switchBranch: (cwd, name) => ipcRenderer.invoke(IPC.gitSwitchBranch, cwd, name),
    createBranch: (cwd, name) => ipcRenderer.invoke(IPC.gitCreateBranch, cwd, name),
    generateMessage: (cwd) => ipcRenderer.invoke(IPC.commitGenerate, cwd)
  }
}

contextBridge.exposeInMainWorld('nodeTerminal', api)
