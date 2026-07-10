// Graceful non-terminal stub surface for the browser (Server Edition) build.
//
// The real namespaces (`pty`, `workspace`, `settings`, the fs/git/files/context group from
// `buildFilesApi`, and `dialog` from the in-app `dialog-picker`) are provided by the ws-bridge;
// everything else here degrades benignly so the renderer boots without a full Electron preload.
// The exact per-member behavior is the boot-path contract encoded in the Task 7 brief (derived
// from a full renderer-boot audit): every `on*` subscription MUST return a callable no-op
// unsubscribe (the renderer uses the return value as a React effect cleanup — a missing member or
// a non-function return is a mount crash), promise members that the boot path awaits resolve to a
// benign value, and everything else rejects with a coded error.
//
// The object is `satisfies Omit<NodeTerminalApi, 'pty' | 'workspace' | 'settings' | 'fs' | 'git'
// | 'files' | 'context' | 'dialog'>`, so the TypeScript compiler is the completeness test: if
// `NodeTerminalApi` gains a member, this file fails to typecheck until the stub is declared.

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

export function buildStubApi(): Omit<
  NodeTerminalApi,
  'pty' | 'workspace' | 'settings' | 'fs' | 'git' | 'files' | 'context' | 'dialog'
> {
  const api = {
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
    clipboard: {
      // The one browser-native member: use the Clipboard API when present, swallow failures.
      writeText: (text: string): void => {
        if (typeof navigator !== 'undefined') {
          void navigator.clipboard?.writeText(text).catch(() => {})
        }
      }
    },
    shell: {
      // no filesystem-reveal in a browser; intentionally inert (see docs/SERVER.md)
      reveal: noop,
      // no OS default-app open in a browser; intentionally inert (see docs/SERVER.md)
      openPath: noop,
      // The one browser-native member: open the URL in a new tab.
      openExternal: (url: string): void => {
        window.open(url, '_blank', 'noopener')
      }
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
      approve: noop,
      reject: noop,
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
  } satisfies Omit<
    NodeTerminalApi,
    'pty' | 'workspace' | 'settings' | 'fs' | 'git' | 'files' | 'context' | 'dialog'
  >

  return api
}
