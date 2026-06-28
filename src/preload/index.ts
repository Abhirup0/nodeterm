import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  CanvasMutation,
  CanvasState,
  NodeTerminalApi,
  PtyCreateOptions,
  UpdateInfo,
  UpdateProgress,
  Workspace
} from '../shared/types'

// Fan a single ipcRenderer listener per channel out to many renderer subscribers. Without
// this, every node that subscribes (e.g. Cmd+M markdown toggle on each terminal/editor) adds
// its own ipcRenderer listener, tripping Node's MaxListeners (>10) warning. Returns unsubscribe.
function subscribe<A extends unknown[] = []>(channel: string) {
  const listeners = new Set<(...args: A) => void>()
  let handler: ((e: unknown, ...args: A) => void) | null = null
  return (listener: (...args: A) => void): (() => void) => {
    if (!handler) {
      handler = (_e, ...args) => listeners.forEach((l) => l(...args))
      ipcRenderer.on(channel, handler)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0 && handler) {
        ipcRenderer.removeListener(channel, handler)
        handler = null
      }
    }
  }
}

// Fan-out subscriber for the host's inbound apply-mutation events (a single ipcRenderer
// listener shared by all renderer subscribers, like the other event channels).
const subscribeMutation = subscribe<[CanvasMutation]>(IPC.remoteHostApplyMutation)
// Fan-out subscriber for the connection-approval prompt (main → host renderer when a client
// finishes the handshake; carries the SAS to show in the approval dialog).
const subscribePeerPending = subscribe<[{ sas: string | null }]>(IPC.remoteHostPeerPending)

const api: NodeTerminalApi = {
  pty: {
    create: (options: PtyCreateOptions) => ipcRenderer.invoke(IPC.ptyCreate, options),
    write: (sessionId, data) => ipcRenderer.send(IPC.ptyWrite, sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send(IPC.ptyResize, sessionId, cols, rows),
    setFlow: (sessionId, resume) => ipcRenderer.send(IPC.ptyFlow, sessionId, resume),
    kill: (sessionId) => ipcRenderer.send(IPC.ptyKill, sessionId),
    destroy: (persistKey) => ipcRenderer.send(IPC.ptyDestroy, persistKey),
    generateName: (persistKey, cwd) => ipcRenderer.invoke(IPC.ptyGenerateName, persistKey, cwd),
    generateGroupName: (memberKeys, cwd) =>
      ipcRenderer.invoke(IPC.ptyGenerateGroupName, memberKeys, cwd),
    capture: (persistKey, full) => ipcRenderer.invoke(IPC.ptyCapture, persistKey, full),
    readScrollback: (persistKey) => ipcRenderer.invoke(IPC.ptyReadScrollback, persistKey),
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
  ssh: {
    list: () => ipcRenderer.invoke(IPC.sshList),
    save: (server) => ipcRenderer.invoke(IPC.sshSave, server),
    remove: (id) => ipcRenderer.invoke(IPC.sshDelete, id),
    importCandidates: () => ipcRenderer.invoke(IPC.sshImport)
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
    generateMessage: (cwd) => ipcRenderer.invoke(IPC.commitGenerate, cwd),
    history: (cwd, options) => ipcRenderer.invoke(IPC.gitHistory, cwd, options),
    commitFiles: (cwd, oid) => ipcRenderer.invoke(IPC.gitCommitFiles, cwd, oid),
    remoteCommitUrl: (cwd, sha) => ipcRenderer.invoke(IPC.gitRemoteCommitUrl, cwd, sha),
    merge: (cwd, ref) => ipcRenderer.invoke(IPC.gitMerge, cwd, ref),
    rebase: (cwd, onto) => ipcRenderer.invoke(IPC.gitRebase, cwd, onto),
    deleteBranch: (cwd, name, force) => ipcRenderer.invoke(IPC.gitDeleteBranch, cwd, name, force),
    renameBranch: (cwd, newName) => ipcRenderer.invoke(IPC.gitRenameBranch, cwd, newName),
    fetch: (cwd) => ipcRenderer.invoke(IPC.gitFetch, cwd),
    forcePush: (cwd) => ipcRenderer.invoke(IPC.gitForcePush, cwd),
    stashPush: (cwd) => ipcRenderer.invoke(IPC.gitStashPush, cwd),
    stashPop: (cwd) => ipcRenderer.invoke(IPC.gitStashPop, cwd),
    revert: (cwd, oid) => ipcRenderer.invoke(IPC.gitRevert, cwd, oid),
    branchAt: (cwd, name, oid) => ipcRenderer.invoke(IPC.gitBranchAt, cwd, name, oid),
    checkoutCommit: (cwd, oid) => ipcRenderer.invoke(IPC.gitCheckoutCommit, cwd, oid),
    repoRoot: (cwd) => ipcRenderer.invoke(IPC.gitRepoRoot, cwd),
    worktreeList: (repoPath) => ipcRenderer.invoke(IPC.gitWorktreeList, repoPath),
    worktreeAdd: (repoPath, wtPath, branch, baseRef, isNew) =>
      ipcRenderer.invoke(IPC.gitWorktreeAdd, repoPath, wtPath, branch, baseRef, isNew),
    worktreeMerge: (repoPath, branch, baseRef) =>
      ipcRenderer.invoke(IPC.gitWorktreeMerge, repoPath, branch, baseRef),
    worktreeRemove: (repoPath, wtPath, deleteBranch) =>
      ipcRenderer.invoke(IPC.gitWorktreeRemove, repoPath, wtPath, deleteBranch)
  },
  clipboard: {
    writeText: (text: string) => clipboard.writeText(text)
  },
  shell: {
    reveal: (path: string) => ipcRenderer.send(IPC.shellReveal, path),
    openPath: (path: string) => ipcRenderer.send(IPC.shellOpenPath, path),
    openExternal: (url: string) => ipcRenderer.send(IPC.shellOpenExternal, url)
  },
  fs: {
    list: (dirPath: string) => ipcRenderer.invoke(IPC.fsList, dirPath),
    read: (filePath: string) => ipcRenderer.invoke(IPC.fsRead, filePath),
    readBinary: (filePath: string) => ipcRenderer.invoke(IPC.fsReadBinary, filePath),
    write: (filePath: string, content: string) => ipcRenderer.invoke(IPC.fsWrite, filePath, content)
  },
  files: {
    quickOpen: (cwd: string) => ipcRenderer.invoke(IPC.filesQuickOpen, cwd)
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
  license: {
    upgrade: () => ipcRenderer.invoke(IPC.licenseUpgrade),
    activate: (key: string) => ipcRenderer.invoke(IPC.licenseActivate, key),
    deactivate: () => ipcRenderer.invoke(IPC.licenseDeactivate),
    getStatus: () => ipcRenderer.invoke(IPC.licenseStatus),
    onChange: (listener) => {
      const handler = (_e: unknown, s: Parameters<typeof listener>[0]) => listener(s)
      ipcRenderer.on(IPC.licenseChanged, handler)
      return () => ipcRenderer.removeListener(IPC.licenseChanged, handler)
    }
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
    },
    ensure: (sessionId, cwd) => ipcRenderer.send(IPC.contextEnsure, sessionId, cwd)
  },
  claude: {
    readTranscript: (sessionId, cwd) =>
      ipcRenderer.invoke(IPC.claudeReadTranscript, sessionId, cwd)
  },
  chat: {
    readTranscript: (sessionId, cwd) =>
      ipcRenderer.invoke(IPC.chatReadTranscript, sessionId, cwd)
  },
  remoteHost: {
    start: () => ipcRenderer.invoke(IPC.remoteHostStart),
    stop: () => ipcRenderer.invoke(IPC.remoteHostStop),
    sendCanvasState: (state) => ipcRenderer.send(IPC.remoteHostCanvasState, state),
    onApplyMutation: subscribeMutation,
    onPeerPending: subscribePeerPending,
    approve: () => ipcRenderer.send(IPC.remoteHostApprove),
    reject: () => ipcRenderer.send(IPC.remoteHostReject)
  },
  remoteClient: {
    connect: (offer) => ipcRenderer.invoke(IPC.remoteClientConnect, offer),
    disconnect: (connectionId) => ipcRenderer.invoke(IPC.remoteClientDisconnect, connectionId),
    create: (connectionId, options) =>
      ipcRenderer.invoke(IPC.remoteClientCreate, connectionId, options),
    write: (connectionId, sessionId, data) =>
      ipcRenderer.send(IPC.remoteClientWrite, connectionId, sessionId, data),
    resize: (connectionId, sessionId, cols, rows) =>
      ipcRenderer.send(IPC.remoteClientResize, connectionId, sessionId, cols, rows),
    kill: (connectionId, sessionId) =>
      ipcRenderer.send(IPC.remoteClientKill, connectionId, sessionId),
    onData: (connectionId, sessionId, listener) => {
      const channel = IPC.remoteClientData(connectionId, Number(sessionId))
      const handler = (_e: unknown, data: string) => listener(data)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onExit: (connectionId, sessionId, listener) => {
      const channel = IPC.remoteClientExit(connectionId, Number(sessionId))
      const handler = (_e: unknown, code: number) => listener(code)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onClosed: (connectionId, listener) => {
      const channel = IPC.remoteClientClosed(connectionId)
      const handler = () => listener()
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onCanvasState: (connectionId, listener) => {
      const channel = IPC.remoteClientCanvasState(connectionId)
      const handler = (_e: unknown, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onSas: (connectionId, listener) => {
      const channel = IPC.remoteClientSas(connectionId)
      const handler = (_e: unknown, sas: string | null) => listener(sas)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    sendMutation: (connectionId, mutation) =>
      ipcRenderer.send(IPC.remoteClientMutate, connectionId, mutation),
    fsList: (connectionId, path) => ipcRenderer.invoke(IPC.remoteClientFsList, connectionId, path),
    fsRead: (connectionId, path) => ipcRenderer.invoke(IPC.remoteClientFsRead, connectionId, path),
    fsReadBinary: (connectionId, path) =>
      ipcRenderer.invoke(IPC.remoteClientFsReadBinary, connectionId, path),
    fsWrite: (connectionId, path, content) =>
      ipcRenderer.invoke(IPC.remoteClientFsWrite, connectionId, path, content)
  },
  handoff: {
    build: (sessionId, agentId, sourceNodeId, cwd) =>
      ipcRenderer.invoke(IPC.handoffBuild, sessionId, agentId, sourceNodeId, cwd)
  },
  contextLink: {
    setLinks: (map) => ipcRenderer.invoke(IPC.contextLinkSetLinks, map)
  },
  // Per-node subscriptions (each terminal/editor listens) — multiplexed so they don't pile up
  // ipcRenderer listeners and trip the MaxListeners warning.
  onMarkdownToggle: subscribe(IPC.appToggleMarkdown),
  onCloseNode: subscribe(IPC.appCloseNode),
  closeWindow: () => ipcRenderer.send(IPC.appCloseWindow),
  setBadgeCount: (count) => ipcRenderer.send(IPC.appSetBadge, count),
  // Absolute path of a dropped/picked File (File.path was removed in Electron 30+).
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  userDataDir: () => ipcRenderer.invoke(IPC.appUserDataDir),
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
