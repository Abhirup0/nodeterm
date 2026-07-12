// WebSocket bridge that reconstructs `window.nodeTerminal` in the browser (Server Edition).
//
// Under Electron the preload already defines `window.nodeTerminal`; this module only runs when
// it is absent (see main.tsx's bootstrap switch). It opens ONE WebSocket to `/ws`, speaks the
// Task-1 RPC protocol (`parseRpcMessage` / `decodePtyData`), and rebuilds the three real
// namespaces (`pty`, `workspace`, `settings`) over that socket. Every other namespace comes from
// `buildStubApi()` (Task 7) so the renderer boots without a full Electron preload.

import { parseRpcMessage, decodePtyData, type RpcMessage } from '../../shared/rpc'
import { IPC } from '../../shared/ipc'
import {
  UNKNOWN_CLAUDE_CLI_CAPS,
  type ClaudeApi,
  type ClaudeCliCaps,
  type ContextApi,
  type FilesApi,
  type FsApi,
  type GitApi,
  type NodeTerminalApi,
  type PresenceApi,
  type PtyApi,
  type PtyCreateOptions,
  type SettingsApi,
  type Settings,
  type Workspace,
  type WorkspaceApi
} from '../../shared/types'
import type { PeerIdentity } from '../../shared/presence'
import { buildStubApi } from './stubs'
import { mountPickerRoot, openDirectoryPicker } from './dialog-picker'

type Listener = (...args: unknown[]) => void

/**
 * One WebSocket, a pending-request map keyed by an incrementing id, and a channel-listener
 * fan-out map. Exported for the unit test (`ws-bridge.test.ts`). Kept free of any DOM/overlay
 * concerns so the test stays clean — reconnect UI lives in `installWsBridge`.
 */
export class RpcClient {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private channels = new Map<string, Set<Listener>>()
  // Events that arrived before any subscriber existed for their channel. The server can push an
  // event in the same macrotask as `open`, so a subscriber registered one microtask later (via
  // `await ready()`) would otherwise miss it. Buffered here (capped) and flushed on subscribe.
  private early: Array<{ channel: string; args: unknown[] }> = []
  private readyPromise: Promise<void>
  private closeCbs = new Set<() => void>()

  constructor(url: string) {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.readyPromise = new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('WebSocket error')))
    })
    ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev.data))
    ws.addEventListener('close', () => this.closeCbs.forEach((cb) => cb()))
  }

  /** Resolves once the socket is open; rejects if it errors before opening. */
  ready(): Promise<void> {
    return this.readyPromise
  }

  /** Register a connection-loss hook (used by the reconnect overlay). */
  onClose(cb: () => void): void {
    this.closeCbs.add(cb)
  }

  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      const m = parseRpcMessage(data)
      if (!m) return
      this.handleJson(m)
      return
    }
    // Binary pty frame. Browser gives ArrayBuffer (binaryType='arraybuffer'); the `ws` package
    // in tests gives a Buffer (already a Uint8Array). Normalize both to a Uint8Array.
    const bytes =
      data instanceof Uint8Array
        ? data
        : data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : null
    if (!bytes) return
    const decoded = decodePtyData(bytes)
    if (!decoded) return
    this.fanOut(IPC.ptyData(decoded.sessionId), [decoded.data])
  }

  private handleJson(m: RpcMessage): void {
    if (m.t === 'res') {
      const entry = this.pending.get(m.id)
      if (!entry) return
      this.pending.delete(m.id)
      if (m.ok) entry.resolve(m.result)
      else entry.reject(Object.assign(new Error(m.error.message), { code: m.error.code }))
    } else if (m.t === 'ev') {
      this.fanOut(m.channel, m.args)
    }
  }

  private fanOut(channel: string, args: unknown[]): void {
    const set = this.channels.get(channel)
    if (!set || set.size === 0) {
      // No subscriber yet — buffer for replay on the first subscribe (capped, drop oldest).
      this.early.push({ channel, args })
      if (this.early.length > 4096) this.early.shift()
      return
    }
    for (const fn of set) fn(...args)
  }

  /** Send a request and resolve with its result (or reject with the coded error). */
  request(method: string, ...args: unknown[]): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ t: 'req', id, method, args }))
    })
  }

  /** Send a fire-and-forget cast (no response expected). */
  cast(method: string, ...args: unknown[]): void {
    this.ws.send(JSON.stringify({ t: 'cast', method, args }))
  }

  /** Subscribe to a channel; returns an unsubscribe function. */
  subscribe(channel: string, fn: Listener): () => void {
    let set = this.channels.get(channel)
    if (!set) {
      set = new Set()
      this.channels.set(channel, set)
    }
    set.add(fn)
    // Flush any events that arrived for this channel before it had a subscriber.
    if (this.early.length > 0) {
      const pending = this.early.filter((e) => e.channel === channel)
      if (pending.length > 0) {
        this.early = this.early.filter((e) => e.channel !== channel)
        for (const e of pending) fn(...e.args)
      }
    }
    return () => {
      set!.delete(fn)
      if (set!.size === 0) this.channels.delete(channel)
    }
  }
}

const AI_NAMING_UNAVAILABLE = {
  ok: false as const,
  message: 'AI naming is not available in the server edition yet'
}

/** Build the three real namespaces (`pty`, `workspace`, `settings`) over an RpcClient, mirroring
 *  the preload's invoke(→request)/send(→cast) split exactly. */
function buildRealApi(client: RpcClient): Pick<NodeTerminalApi, 'pty' | 'workspace' | 'settings'> {
  const pty: PtyApi = {
    create: (options: PtyCreateOptions) =>
      client.request(IPC.ptyCreate, options) as ReturnType<PtyApi['create']>,
    write: (sessionId, data) => client.cast(IPC.ptyWrite, sessionId, data),
    resize: (sessionId, cols, rows) => client.cast(IPC.ptyResize, sessionId, cols, rows),
    setFlow: (sessionId, resume) => client.cast(IPC.ptyFlow, sessionId, resume),
    kill: (sessionId) => client.cast(IPC.ptyKill, sessionId),
    destroy: (persistKey) => client.cast(IPC.ptyDestroy, persistKey),
    recycle: (persistKey) => client.cast(IPC.ptyRecycle, persistKey),
    // No server handler — degrade gracefully (never reject the boot path).
    generateName: () => Promise.resolve(AI_NAMING_UNAVAILABLE),
    generateGroupName: () => Promise.resolve(AI_NAMING_UNAVAILABLE),
    capture: (persistKey, full) =>
      client.request(IPC.ptyCapture, persistKey, full).catch(() => '') as Promise<string>,
    readScrollback: (persistKey) =>
      client.request(IPC.ptyReadScrollback, persistKey) as Promise<string>,
    captureHistory: (persistKey: string) =>
      client.request(IPC.ptyCaptureHistory, persistKey) as Promise<string>,
    sendText: (persistKey, text) =>
      client.request(IPC.ptySendText, persistKey, text) as Promise<boolean>,
    // No server handler — the session-name poll degrades to no adopted name.
    readSessionName: () => Promise.resolve(''),
    onData: (sessionId, listener) =>
      client.subscribe(IPC.ptyData(sessionId), listener as Listener),
    onExit: (sessionId, listener) =>
      client.subscribe(IPC.ptyExit(sessionId), listener as Listener),
    // Co-attach channels: ordinary JSON `ev` frames (only pty:data is binary), so the frame
    // decoder is unchanged — they just fan out through the generic channel subscription.
    onSize: (sessionId, listener) => client.subscribe(IPC.ptySize(sessionId), listener as Listener),
    onClosed: (sessionId, listener) =>
      client.subscribe(IPC.ptyClosed(sessionId), listener as Listener),
    onRecycled: (sessionId, listener) =>
      client.subscribe(IPC.ptyRecycled(sessionId), listener as Listener),
    onResync: (sessionId, listener) =>
      client.subscribe(IPC.ptyResync(sessionId), listener as Listener)
  }

  const workspace: WorkspaceApi = {
    load: () => client.request(IPC.workspaceLoad) as Promise<Workspace>,
    save: (ws: Workspace) => client.request(IPC.workspaceSave, ws) as Promise<void>,
    // No server handler — per-project file storage is desktop-only for now; degrade
    // gracefully (null probe, no-op event subscriptions) so the boot path never rejects.
    probeFolder: () => Promise.resolve(null),
    onMigrated: () => () => {},
    onExternalChange: () => () => {}
  }

  const settings: SettingsApi = {
    load: () => client.request(IPC.settingsLoad) as Promise<Settings>,
    save: (s: Settings) => client.request(IPC.settingsSave, s) as Promise<void>
  }

  return { pty, workspace, settings }
}

/**
 * Build the real `fs` / `git` / `files` / `context` namespaces over an RpcClient, mirroring the
 * preload's invoke(→request) / send(→cast) / on*(→subscribe) split member-for-member. Every
 * `fs.*`, `git.*`, `files.quickOpen` and `git.generateMessage` member is an `invoke` in the
 * preload → `client.request`; `context.ensure` is a `send` → `client.cast`; the event-shaped
 * `git.onCloneProgress` / `context.onUpdate` are `.on` → `client.subscribe`. `git.generateMessage`
 * routes over `IPC.commitGenerate` (not a git:* channel) exactly as the preload does. Each namespace
 * is declared against its `NodeTerminalApi` slice so `satisfies` makes the compiler the completeness
 * gate: a missing or misnamed member fails typecheck.
 */
export function buildFilesApi(
  client: RpcClient
): Pick<NodeTerminalApi, 'fs' | 'git' | 'files' | 'context'> {
  const fs: FsApi = {
    list: (dirPath) => client.request(IPC.fsList, dirPath) as ReturnType<FsApi['list']>,
    read: (filePath) => client.request(IPC.fsRead, filePath) as Promise<string>,
    readBinary: (filePath) => client.request(IPC.fsReadBinary, filePath) as Promise<string>,
    write: (filePath, content) => client.request(IPC.fsWrite, filePath, content) as Promise<boolean>
  }

  const git: GitApi = {
    status: (cwd) => client.request(IPC.gitStatus, cwd) as ReturnType<GitApi['status']>,
    init: (cwd) => client.request(IPC.gitInit, cwd) as ReturnType<GitApi['init']>,
    clone: (parentDir, url) =>
      client.request(IPC.gitClone, parentDir, url) as ReturnType<GitApi['clone']>,
    cloneAbort: () => client.request(IPC.gitCloneAbort) as Promise<void>,
    cloneDefaultParent: () => client.request(IPC.gitCloneDefaultParent) as Promise<string>,
    onCloneProgress: (listener) => client.subscribe(IPC.gitCloneProgress, listener as Listener),
    commit: (cwd, message) =>
      client.request(IPC.gitCommit, cwd, message) as ReturnType<GitApi['commit']>,
    push: (cwd) => client.request(IPC.gitPush, cwd) as ReturnType<GitApi['push']>,
    pull: (cwd) => client.request(IPC.gitPull, cwd) as ReturnType<GitApi['pull']>,
    sync: (cwd) => client.request(IPC.gitSync, cwd) as ReturnType<GitApi['sync']>,
    publish: (cwd, name, isPrivate) =>
      client.request(IPC.gitPublish, cwd, name, isPrivate) as ReturnType<GitApi['publish']>,
    stage: (cwd, paths) => client.request(IPC.gitStage, cwd, paths) as ReturnType<GitApi['stage']>,
    unstage: (cwd, paths) =>
      client.request(IPC.gitUnstage, cwd, paths) as ReturnType<GitApi['unstage']>,
    stageAll: (cwd) => client.request(IPC.gitStageAll, cwd) as ReturnType<GitApi['stageAll']>,
    unstageAll: (cwd) => client.request(IPC.gitUnstageAll, cwd) as ReturnType<GitApi['unstageAll']>,
    diff: (cwd, path, staged, untracked) =>
      client.request(IPC.gitDiff, cwd, path, staged, untracked) as Promise<string>,
    discard: (cwd, path, untracked) =>
      client.request(IPC.gitDiscard, cwd, path, untracked) as ReturnType<GitApi['discard']>,
    switchBranch: (cwd, name) =>
      client.request(IPC.gitSwitchBranch, cwd, name) as ReturnType<GitApi['switchBranch']>,
    createBranch: (cwd, name) =>
      client.request(IPC.gitCreateBranch, cwd, name) as ReturnType<GitApi['createBranch']>,
    showFile: (cwd, ref, path) =>
      client.request(IPC.gitShowFile, cwd, ref, path) as Promise<string>,
    generateMessage: (cwd) =>
      client.request(IPC.commitGenerate, cwd) as ReturnType<GitApi['generateMessage']>,
    history: (cwd, options) =>
      client.request(IPC.gitHistory, cwd, options) as ReturnType<GitApi['history']>,
    commitFiles: (cwd, oid) =>
      client.request(IPC.gitCommitFiles, cwd, oid) as ReturnType<GitApi['commitFiles']>,
    remoteCommitUrl: (cwd, sha) =>
      client.request(IPC.gitRemoteCommitUrl, cwd, sha) as Promise<string | null>,
    merge: (cwd, ref) => client.request(IPC.gitMerge, cwd, ref) as ReturnType<GitApi['merge']>,
    rebase: (cwd, onto) => client.request(IPC.gitRebase, cwd, onto) as ReturnType<GitApi['rebase']>,
    deleteBranch: (cwd, name, force) =>
      client.request(IPC.gitDeleteBranch, cwd, name, force) as ReturnType<GitApi['deleteBranch']>,
    renameBranch: (cwd, newName) =>
      client.request(IPC.gitRenameBranch, cwd, newName) as ReturnType<GitApi['renameBranch']>,
    fetch: (cwd) => client.request(IPC.gitFetch, cwd) as ReturnType<GitApi['fetch']>,
    forcePush: (cwd) => client.request(IPC.gitForcePush, cwd) as ReturnType<GitApi['forcePush']>,
    stashPush: (cwd) => client.request(IPC.gitStashPush, cwd) as ReturnType<GitApi['stashPush']>,
    stashPop: (cwd) => client.request(IPC.gitStashPop, cwd) as ReturnType<GitApi['stashPop']>,
    revert: (cwd, oid) => client.request(IPC.gitRevert, cwd, oid) as ReturnType<GitApi['revert']>,
    branchAt: (cwd, name, oid) =>
      client.request(IPC.gitBranchAt, cwd, name, oid) as ReturnType<GitApi['branchAt']>,
    checkoutCommit: (cwd, oid) =>
      client.request(IPC.gitCheckoutCommit, cwd, oid) as ReturnType<GitApi['checkoutCommit']>,
    repoRoot: (cwd) => client.request(IPC.gitRepoRoot, cwd) as Promise<string | null>,
    worktreeList: (repoPath) =>
      client.request(IPC.gitWorktreeList, repoPath) as ReturnType<GitApi['worktreeList']>,
    worktreeAdd: (repoPath, wtPath, branch, baseRef, isNew) =>
      client.request(
        IPC.gitWorktreeAdd,
        repoPath,
        wtPath,
        branch,
        baseRef,
        isNew
      ) as ReturnType<GitApi['worktreeAdd']>,
    worktreeMerge: (repoPath, branch, baseRef) =>
      client.request(
        IPC.gitWorktreeMerge,
        repoPath,
        branch,
        baseRef
      ) as ReturnType<GitApi['worktreeMerge']>,
    worktreeRemove: (repoPath, wtPath, deleteBranch) =>
      client.request(
        IPC.gitWorktreeRemove,
        repoPath,
        wtPath,
        deleteBranch
      ) as ReturnType<GitApi['worktreeRemove']>,
    setActiveRemote: (projectId) =>
      client.request(IPC.gitSetActiveRemote, projectId) as Promise<void>
  }

  const files: FilesApi = {
    quickOpen: (cwd) => client.request(IPC.filesQuickOpen, cwd) as Promise<string[]>
  }

  const context: ContextApi = {
    onUpdate: (listener) => client.subscribe(IPC.contextUpdate, listener as Listener),
    ensure: (sessionId, cwd, accountId) =>
      client.cast(IPC.contextEnsure, sessionId, cwd, accountId)
  }

  return { fs, git, files, context }
}

/**
 * Build the top-level agent-event subscriptions (`onAgentStatus` / `onSubagentActivity`) over an
 * RpcClient. These mirror the preload's `.on(channel, …)` → `client.subscribe(channel, …)` split:
 * each takes a listener and returns an unsubscribe. Declared against its `NodeTerminalApi` slice so
 * `satisfies` keeps the compiler as the completeness gate.
 */
export function buildAgentApi(
  client: RpcClient
): Pick<NodeTerminalApi, 'onAgentStatus' | 'onSubagentActivity'> {
  return {
    onAgentStatus: (listener) => client.subscribe(IPC.agentStatus, listener as Listener),
    onSubagentActivity: (listener) =>
      client.subscribe(IPC.agentSubagentActivity, listener as Listener)
  }
}

/**
 * Build the `canvas` namespace over an RpcClient: a cast out (`canvas:mut`) and a subscription in on
 * the same channel. The server stamps each mutation with the total order (`seq`) and reflects it to
 * every client, us included — our own frame coming back is the ACK that carries our place in that
 * order (the renderer recognizes it by `src`; see src/shared/canvas-order.ts). This is a REAL
 * implementation, not a stub:
 * the Server Edition (two browsers on one workspace) is the surface that needs canvas sync most.
 */
export function buildCanvasApi(client: RpcClient): Pick<NodeTerminalApi, 'canvas'> {
  return {
    canvas: {
      mutate: (projectId, mutation) => client.cast(IPC.canvasMut, projectId, mutation),
      onMutation: (listener) => client.subscribe(IPC.canvasMut, listener as Listener)
    }
  }
}

/**
 * Build the `presence` namespace over an RpcClient, mirroring the preload's invoke(→request) /
 * send(→cast) / on(→subscribe) split member-for-member: `hello` is the only request (its response
 * is how a client learns its OWN clientId), cursor/focus/chat/project are casts, and the two event
 * channels are subscriptions. Declared against its `NodeTerminalApi` slice so `satisfies` keeps
 * the compiler as the completeness gate.
 */
export function buildPresenceApi(client: RpcClient): Pick<NodeTerminalApi, 'presence'> {
  const presence: PresenceApi = {
    hello: (identity: PeerIdentity) =>
      client.request(IPC.presenceHello, identity) as ReturnType<PresenceApi['hello']>,
    cursor: (cursor) => client.cast(IPC.presenceCursor, cursor),
    focus: (nodeId) => client.cast(IPC.presenceFocus, nodeId),
    chat: (text) => client.cast(IPC.presenceChat, text),
    project: (projectId) => client.cast(IPC.presenceProject, projectId),
    onSync: (listener) => client.subscribe(IPC.presenceSync, listener as Listener),
    onPeer: (listener) => client.subscribe(IPC.presencePeer, listener as Listener)
  }
  return { presence }
}

/**
 * Build the `claude` namespace over an RpcClient. `cliCaps` is a REAL handler on the server
 * (`registerClaudeCliIpc` runs in the server shell too), so the browser resolves the very same
 * `--permission-mode auto` version gate as desktop instead of silently no-opping into "auto
 * unsupported" — which would strip the flag from every Claude launch in the Server Edition.
 * A failed request degrades to the fail-open caps (bare command), never a rejection: the launch
 * path awaits this. `readTranscript` has no server handler yet, so it keeps the stub's reject.
 */
export function buildClaudeApi(client: RpcClient, stub: ClaudeApi): ClaudeApi {
  return {
    ...stub,
    cliCaps: () =>
      (client.request(IPC.claudeCliCaps) as Promise<ClaudeCliCaps>).catch(
        () => UNKNOWN_CLAUDE_CLI_CAPS
      )
  }
}

/** WS URL for the current page: same host, `/ws`, ws→http / wss→https. */
function wsUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/ws`
}

// ── Reconnect overlay (kept out of RpcClient's unit-tested core) ────────────────────────────
const OVERLAY_ID = 'nt-reconnect-overlay'

/** Is the reconnect overlay currently mounted? Exported for the unit test. */
export function isOverlayMounted(): boolean {
  return typeof document !== 'undefined' && document.getElementById(OVERLAY_ID) !== null
}

/** Mount the full-screen "reconnecting" overlay (idempotent). Exported so both the initial-connect
 *  failure path and the later onClose path — and the unit test — mount the identical UI. */
export function showReconnectOverlay(): void {
  if (typeof document === 'undefined' || document.getElementById(OVERLAY_ID)) return
  const el = document.createElement('div')
  el.id = OVERLAY_ID
  el.setAttribute('data-nt-reconnect', '')
  el.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,0.72);color:#fff;' +
    'font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;padding:24px'
  el.textContent = 'Connection lost — reconnecting…'
  document.body.appendChild(el)
}

/** Retry the WS with backoff (1s→2s→4s→…→10s cap). On the first successful reopen, reload the
 *  page (the reloaded app re-runs `pty.create` per node with the same persistKey → tmux warm
 *  reattach). After 3 consecutive failed retries, bounce to `/login` (assume auth expired). */
function startReconnect(): void {
  showReconnectOverlay()
  let attempt = 0
  let failures = 0

  const tryOnce = (): void => {
    let probe: WebSocket
    try {
      probe = new WebSocket(wsUrl())
    } catch {
      scheduleRetry()
      return
    }
    probe.binaryType = 'arraybuffer'
    const cleanup = (): void => {
      probe.onopen = null
      probe.onerror = null
      probe.onclose = null
    }
    probe.onopen = () => {
      cleanup()
      try {
        probe.close()
      } catch {
        /* ignore */
      }
      location.reload()
    }
    probe.onerror = () => {
      // Let onclose drive the retry/failure counting (fires after error).
    }
    probe.onclose = () => {
      cleanup()
      failures++
      if (failures >= 3) {
        location.href = '/login'
        return
      }
      scheduleRetry()
    }
  }

  const scheduleRetry = (): void => {
    const delay = Math.min(1000 * 2 ** attempt, 10000)
    attempt++
    setTimeout(tryOnce, delay)
  }

  scheduleRetry()
}

/**
 * Connect the WS bridge and install `window.nodeTerminal`. Awaited by main.tsx's bootstrap
 * before the app boots, so the real namespaces are present on first render. Resolves `true` once
 * the socket is open and `window.nodeTerminal` is assigned; resolves `false` on the initial-connect
 * failure path (overlay shown, reconnect loop running) so bootstrap can skip loading the app.
 */
export async function installWsBridge(): Promise<boolean> {
  const client = new RpcClient(wsUrl())
  try {
    await client.ready()
  } catch {
    // First connection failed (server down at page load, or the socket errored before opening).
    // Show the SAME reconnect overlay + backoff loop as a later drop instead of rejecting — a
    // rejection here would bubble out of bootstrap() and leave a blank screen. `startReconnect`
    // reloads the page on the first successful reopen, which re-runs installWsBridge cleanly.
    // Return false so bootstrap skips `import('./boot')` — booting the app with an undefined
    // `window.nodeTerminal` throws under the (opaque) overlay.
    startReconnect()
    return false
  }
  client.onClose(() => startReconnect())
  const stubApi = buildStubApi()
  const api: NodeTerminalApi = {
    ...stubApi,
    ...buildRealApi(client),
    ...buildFilesApi(client),
    ...buildAgentApi(client),
    ...buildCanvasApi(client),
    ...buildPresenceApi(client),
    // Only `cliCaps` is real here — the rest of the namespace stays stubbed (see buildClaudeApi).
    claude: buildClaudeApi(client, stubApi.claude),
    // Web replacement for the Electron native dialog: an in-app server-directory browser over
    // fs.list (the stub's E_UNSUPPORTED reject is dropped in favor of this real picker).
    dialog: (() => {
      mountPickerRoot()
      const startDir = '/' // navigable up/down from root; the picker remembers nothing across calls in v1
      return {
        selectFolder: () => openDirectoryPicker({ mode: 'folder', startDir, list: api.fs.list }),
        selectFile: () => openDirectoryPicker({ mode: 'file', startDir, list: api.fs.list })
      }
    })()
  }
  ;(window as unknown as { nodeTerminal: NodeTerminalApi }).nodeTerminal = api
  return true
}
