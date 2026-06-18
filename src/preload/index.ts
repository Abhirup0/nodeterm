import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  NodeTerminalApi,
  PtyCreateOptions,
  UpdateInfo,
  UpdateProgress,
  Workspace
} from '../shared/types'

const api: NodeTerminalApi = {
  pty: {
    create: (options: PtyCreateOptions) => ipcRenderer.invoke(IPC.ptyCreate, options),
    write: (sessionId, data) => ipcRenderer.send(IPC.ptyWrite, sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send(IPC.ptyResize, sessionId, cols, rows),
    setFlow: (sessionId, resume) => ipcRenderer.send(IPC.ptyFlow, sessionId, resume),
    kill: (sessionId) => ipcRenderer.send(IPC.ptyKill, sessionId),
    destroy: (persistKey) => ipcRenderer.send(IPC.ptyDestroy, persistKey),
    generateName: (persistKey, cwd) => ipcRenderer.invoke(IPC.ptyGenerateName, persistKey, cwd),
    capture: (persistKey, full) => ipcRenderer.invoke(IPC.ptyCapture, persistKey, full),
    sendText: (persistKey, text) => ipcRenderer.invoke(IPC.ptySendText, persistKey, text),
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
    selectFolder: () => ipcRenderer.invoke(IPC.dialogSelectFolder),
    selectFile: () => ipcRenderer.invoke(IPC.dialogSelectFile)
  },
  settings: {
    load: () => ipcRenderer.invoke(IPC.settingsLoad),
    save: (settings) => ipcRenderer.invoke(IPC.settingsSave, settings)
  },
  git: {
    status: (cwd) => ipcRenderer.invoke(IPC.gitStatus, cwd),
    init: (cwd) => ipcRenderer.invoke(IPC.gitInit, cwd),
    clone: (parentDir, url) => ipcRenderer.invoke(IPC.gitClone, parentDir, url),
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
    showFile: (cwd, ref, path) => ipcRenderer.invoke(IPC.gitShowFile, cwd, ref, path),
    generateMessage: (cwd) => ipcRenderer.invoke(IPC.commitGenerate, cwd)
  },
  clipboard: {
    writeText: (text: string) => clipboard.writeText(text)
  },
  shell: {
    reveal: (path: string) => ipcRenderer.send(IPC.shellReveal, path),
    openPath: (path: string) => ipcRenderer.send(IPC.shellOpenPath, path)
  },
  fs: {
    list: (dirPath: string) => ipcRenderer.invoke(IPC.fsList, dirPath),
    read: (filePath: string) => ipcRenderer.invoke(IPC.fsRead, filePath),
    readBinary: (filePath: string) => ipcRenderer.invoke(IPC.fsReadBinary, filePath),
    write: (filePath: string, content: string) => ipcRenderer.invoke(IPC.fsWrite, filePath, content)
  },
  updates: {
    onAvailable: (listener) => {
      const handler = (_e: unknown, info: UpdateInfo) => listener(info)
      ipcRenderer.on(IPC.appUpdateAvailable, handler)
      return () => ipcRenderer.removeListener(IPC.appUpdateAvailable, handler)
    },
    onDownloaded: (listener) => {
      const handler = (_e: unknown, info: UpdateInfo) => listener(info)
      ipcRenderer.on(IPC.appUpdateDownloaded, handler)
      return () => ipcRenderer.removeListener(IPC.appUpdateDownloaded, handler)
    },
    onProgress: (listener) => {
      const handler = (_e: unknown, p: UpdateProgress) => listener(p)
      ipcRenderer.on(IPC.appUpdateProgress, handler)
      return () => ipcRenderer.removeListener(IPC.appUpdateProgress, handler)
    },
    onError: (listener) => {
      const handler = (_e: unknown, message: string) => listener(message)
      ipcRenderer.on(IPC.appUpdateError, handler)
      return () => ipcRenderer.removeListener(IPC.appUpdateError, handler)
    },
    onNotAvailable: (listener) => {
      const handler = () => listener()
      ipcRenderer.on(IPC.appUpdateNotAvailable, handler)
      return () => ipcRenderer.removeListener(IPC.appUpdateNotAvailable, handler)
    },
    check: () => ipcRenderer.send(IPC.appCheckForUpdates),
    getVersion: () => ipcRenderer.invoke(IPC.appGetVersion),
    getPolicy: () => ipcRenderer.invoke(IPC.appUpdatePolicy),
    restart: () => ipcRenderer.send(IPC.appRestartToUpdate)
  },
  announcements: {
    fetch: () => ipcRenderer.invoke(IPC.announcementsFetch)
  },
  usage: {
    fetch: () => ipcRenderer.invoke(IPC.usageFetch),
    refresh: () => ipcRenderer.invoke(IPC.usageRefresh),
    onUpdate: (listener) => {
      const handler = (_e: unknown, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on(IPC.usageUpdate, handler)
      return () => ipcRenderer.removeListener(IPC.usageUpdate, handler)
    }
  },
  context: {
    onUpdate: (listener) => {
      const handler = (_e: unknown, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on(IPC.contextUpdate, handler)
      return () => ipcRenderer.removeListener(IPC.contextUpdate, handler)
    }
  },
  bridge: {
    configPath: () => ipcRenderer.invoke(IPC.bridgeConfigPath),
    setTopology: (topology) => ipcRenderer.invoke(IPC.bridgeSetTopology, topology),
    onMessage: (listener) => {
      const handler = (_e: unknown, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on(IPC.bridgeMessage, handler)
      return () => ipcRenderer.removeListener(IPC.bridgeMessage, handler)
    }
  },
  onMarkdownToggle: (listener) => {
    const handler = () => listener()
    ipcRenderer.on(IPC.appToggleMarkdown, handler)
    return () => ipcRenderer.removeListener(IPC.appToggleMarkdown, handler)
  },
  onCloseNode: (listener) => {
    const handler = () => listener()
    ipcRenderer.on(IPC.appCloseNode, handler)
    return () => ipcRenderer.removeListener(IPC.appCloseNode, handler)
  },
  closeWindow: () => ipcRenderer.send(IPC.appCloseWindow),
  setBadgeCount: (count) => ipcRenderer.send(IPC.appSetBadge, count),
  // Absolute path of a dropped/picked File (File.path was removed in Electron 30+).
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  notify: (payload) => ipcRenderer.invoke(IPC.appNotify, payload),
  onFocusNode: (listener) => {
    const handler = (_e: unknown, nodeId: string) => listener(nodeId)
    ipcRenderer.on(IPC.appFocusNode, handler)
    return () => ipcRenderer.removeListener(IPC.appFocusNode, handler)
  },
  onAgentStatus: (listener) => {
    const handler = (_e: unknown, payload: Parameters<typeof listener>[0]) => listener(payload)
    ipcRenderer.on(IPC.agentStatus, handler)
    return () => ipcRenderer.removeListener(IPC.agentStatus, handler)
  },
  onSubagentActivity: (listener) => {
    const handler = (_e: unknown, payload: Parameters<typeof listener>[0]) => listener(payload)
    ipcRenderer.on(IPC.agentSubagentActivity, handler)
    return () => ipcRenderer.removeListener(IPC.agentSubagentActivity, handler)
  }
}

contextBridge.exposeInMainWorld('nodeTerminal', api)
