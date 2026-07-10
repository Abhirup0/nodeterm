// Graceful non-terminal stub surface for the browser (Server Edition) build.
//
// The three real namespaces (`pty`, `workspace`, `settings`) are provided by the ws-bridge
// (Task 8); everything else here degrades benignly so the renderer boots without a full
// Electron preload. The exact per-member behavior is the boot-path contract encoded in the
// Task 7 brief (derived from a full renderer-boot audit): every `on*` subscription MUST return
// a callable no-op unsubscribe (the renderer uses the return value as a React effect cleanup —
// a missing member or a non-function return is a mount crash), promise members that the boot
// path awaits resolve to a benign value, and everything else rejects with a coded error.
//
// The object is `satisfies Omit<NodeTerminalApi, 'pty' | 'workspace' | 'settings'>`, so the
// TypeScript compiler is the completeness test: if `NodeTerminalApi` gains a member, this file
// fails to typecheck until the stub is declared.

import type { ClaudeUsage, NodeTerminalApi, NotifyPayload, UpdatePolicy } from '../../shared/types'
import { E_UNSUPPORTED } from '../../shared/rpc'

/** Reject with a coded error the RPC layer + renderer recognize (renderer degrades silently). */
export function unsupported(name: string): Promise<never> {
  return Promise.reject(
    Object.assign(new Error(`${name} is not supported in the browser build`), {
      code: E_UNSUPPORTED
    })
  )
}

/** A subscription stub: ignores its listener, returns a no-op unsubscribe. */
export const noopUnsub: () => () => void = () => () => {}

// Per-member helpers. Each returned function ignores its arguments, so it is assignable to the
// real (more-specific) member signature while `satisfies` still enforces the member exists.
/** Promise member that is unavailable on the server. */
const U = (name: string) => (): Promise<never> => unsupported(name)
/** Void (fire-and-forget) member: a synchronous no-op. */
const noop = (): void => {}
/** Promise<void> member: a resolved no-op. */
const pnoop = (): Promise<void> => Promise.resolve()

export function buildStubApi(): Omit<NodeTerminalApi, 'pty' | 'workspace' | 'settings'> {
  const api = {
    dialog: {
      // Web folder/file pickers are Phase 3.
      selectFolder: U('dialog.selectFolder'),
      selectFile: U('dialog.selectFile')
    },
    ssh: {
      list: U('ssh.list'),
      save: U('ssh.save'),
      remove: U('ssh.remove'),
      importCandidates: U('ssh.importCandidates')
    },
    sshProject: {
      connect: U('sshProject.connect'),
      disconnect: U('sshProject.disconnect'),
      killSessions: U('sshProject.killSessions'),
      listDir: U('sshProject.listDir'),
      mkdir: U('sshProject.mkdir'),
      uploadFile: U('sshProject.uploadFile'),
      onStatus: noopUnsub
    },
    sshFs: {
      list: U('sshFs.list'),
      read: U('sshFs.read'),
      readBinary: U('sshFs.readBinary'),
      write: U('sshFs.write')
    },
    git: {
      status: U('git.status'),
      init: U('git.init'),
      clone: U('git.clone'),
      cloneAbort: U('git.cloneAbort'),
      cloneDefaultParent: U('git.cloneDefaultParent'),
      onCloneProgress: noopUnsub,
      commit: U('git.commit'),
      push: U('git.push'),
      pull: U('git.pull'),
      sync: U('git.sync'),
      publish: U('git.publish'),
      stage: U('git.stage'),
      unstage: U('git.unstage'),
      stageAll: U('git.stageAll'),
      unstageAll: U('git.unstageAll'),
      diff: U('git.diff'),
      discard: U('git.discard'),
      switchBranch: U('git.switchBranch'),
      createBranch: U('git.createBranch'),
      showFile: U('git.showFile'),
      generateMessage: U('git.generateMessage'),
      history: U('git.history'),
      commitFiles: U('git.commitFiles'),
      remoteCommitUrl: U('git.remoteCommitUrl'),
      merge: U('git.merge'),
      rebase: U('git.rebase'),
      deleteBranch: U('git.deleteBranch'),
      renameBranch: U('git.renameBranch'),
      fetch: U('git.fetch'),
      forcePush: U('git.forcePush'),
      stashPush: U('git.stashPush'),
      stashPop: U('git.stashPop'),
      revert: U('git.revert'),
      branchAt: U('git.branchAt'),
      checkoutCommit: U('git.checkoutCommit'),
      repoRoot: U('git.repoRoot'),
      worktreeList: U('git.worktreeList'),
      worktreeAdd: U('git.worktreeAdd'),
      worktreeMerge: U('git.worktreeMerge'),
      worktreeRemove: U('git.worktreeRemove'),
      setActiveRemote: U('git.setActiveRemote')
    },
    clipboard: {
      // The one browser-native member: use the Clipboard API when present, swallow failures.
      writeText: (text: string): void => {
        if (typeof navigator !== 'undefined') {
          void navigator.clipboard?.writeText(text).catch(() => {})
        }
      }
    },
    shell: {
      reveal: noop,
      openPath: noop,
      openExternal: noop
    },
    fs: {
      list: U('fs.list'),
      read: U('fs.read'),
      readBinary: U('fs.readBinary'),
      write: U('fs.write')
    },
    media: {
      allow: U('media.allow'),
      writeHtml: U('media.writeHtml')
    },
    browser: {
      register: noop,
      unregister: noop,
      onBrowserNewWindow: noopUnsub
    },
    files: {
      quickOpen: U('files.quickOpen')
    },
    updates: {
      onAvailable: noopUnsub,
      onDownloaded: noopUnsub,
      onProgress: noopUnsub,
      onError: noopUnsub,
      onNotAvailable: noopUnsub,
      check: noop,
      getVersion: U('updates.getVersion'),
      // Boot path awaits this; null = "no policy" so the update card stays inert.
      getPolicy: (): Promise<UpdatePolicy> => Promise.resolve(null as unknown as UpdatePolicy),
      restart: noop
    },
    announcements: {
      fetch: () => Promise.resolve([])
    },
    license: {
      upgrade: U('license.upgrade'),
      activate: U('license.activate'),
      deactivate: U('license.deactivate'),
      // Renderer has no catch here and silently degrades to the free tier on rejection.
      getStatus: U('license.getStatus'),
      onChange: noopUnsub
    },
    contextLink: {
      setLinks: pnoop,
      info: U('contextLink.info')
    },
    usage: {
      // Boot path awaits this; null = "no usage snapshot" so the indicator hides.
      fetch: (): Promise<ClaudeUsage> => Promise.resolve(null as unknown as ClaudeUsage),
      refresh: U('usage.refresh'),
      onUpdate: noopUnsub
    },
    context: {
      onUpdate: noopUnsub,
      ensure: noop
    },
    claude: {
      readTranscript: U('claude.readTranscript')
    },
    chat: {
      readTranscript: U('chat.readTranscript'),
      ensure: U('chat.ensure'),
      send: noop,
      interrupt: noop,
      permissionReply: noop,
      removeQueued: noop,
      dispose: noop,
      onEvent: noopUnsub
    },
    claudeAccounts: {
      add: U('claudeAccounts.add'),
      waitLogin: U('claudeAccounts.waitLogin'),
      cancelWaitLogin: U('claudeAccounts.cancelWaitLogin'),
      remove: U('claudeAccounts.remove')
    },
    transcripts: {
      search: U('transcripts.search')
    },
    remoteHost: {
      start: U('remoteHost.start'),
      stop: U('remoteHost.stop'),
      sendCanvasState: noop,
      onApplyMutation: noopUnsub,
      onPeerPending: noopUnsub,
      approve: (_id: string) => {},
      reject: (_id: string) => {},
      setPhoneAccess: noop
    },
    remoteClient: {
      connect: U('remoteClient.connect'),
      disconnect: U('remoteClient.disconnect'),
      create: U('remoteClient.create'),
      write: noop,
      resize: noop,
      kill: noop,
      onData: noopUnsub,
      onExit: noopUnsub,
      onClosed: noopUnsub,
      onCanvasState: noopUnsub,
      onSas: noopUnsub,
      sendMutation: noop,
      fsList: U('remoteClient.fsList'),
      fsRead: U('remoteClient.fsRead'),
      fsReadBinary: U('remoteClient.fsReadBinary'),
      fsWrite: U('remoteClient.fsWrite')
    },
    handoff: {
      build: U('handoff.build')
    },
    pairing: {
      start: U('pairing.start'),
      stop: U('pairing.stop'),
      onDone: noopUnsub,
      listDevices: U('pairing.listDevices'),
      revokeDevice: U('pairing.revokeDevice')
    },
    onMarkdownToggle: noopUnsub,
    onCloseNode: noopUnsub,
    closeWindow: noop,
    setBadgeCount: noop,
    getPathForFile: (): string => '',
    userDataDir: (): Promise<string> => Promise.resolve(''),
    notify: async (payload: NotifyPayload): Promise<'shown' | 'failed' | 'skipped'> => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(payload.title, { body: payload.body })
          return 'shown'
        } catch {
          return 'skipped'
        }
      }
      return 'skipped'
    },
    openNotificationSettings: pnoop,
    onFocusNode: noopUnsub,
    onAgentStatus: noopUnsub,
    onSubagentActivity: noopUnsub,
    onAgentControl: noopUnsub,
    sendAgentControlResult: noop
  } satisfies Omit<NodeTerminalApi, 'pty' | 'workspace' | 'settings'>

  return api
}
