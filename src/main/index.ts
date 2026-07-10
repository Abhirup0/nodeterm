import { join, resolve, posix } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { IPC } from '../shared/ipc'
import * as fsOps from '../core/fs-ops'
import { PtyManager } from '../core/pty-manager'
import { WorkspaceStore } from '../core/workspace-store'
import { SettingsStore } from '../core/settings-store'
import { SshStore } from './ssh-store'
import { GitService } from '../core/git-service'
import { generateCommitMessage, generateGroupName, generateTerminalName } from './commit-message'
import { initUpdater } from './updater'
import { fetchCheck } from '../core/check'
import { hookServer } from '../core/agents/hook-server'
import { setMainWindow, getMainWindow, sendToMain, shouldHideOnClose } from './main-window'
import { initAgentStatusMirror, recordAgentEvent } from '../core/agent-status-mirror'
import { retainUntilDismissed } from './notifications'
import { installManagedAgentHooks } from '../core/agents/hooks'
import { createSubagentTail } from '../core/subagent-tail'
import { createContextTail, type TaskNotification } from '../core/context-tail'
import { isAsyncSubagentLaunch, type NormalizedAgentEvent } from '../shared/agents/normalize'
import {
  readTranscriptLines,
  readChatMessages,
  readSessionName,
  resolveTranscriptPath,
  transcriptPathForCwd,
  parseTranscriptLines,
  parseChatMessages,
  SESSION_ID_RE
} from '../core/transcript-reader'
import { createRemoteContextTail } from './remote-context-tail'
import { createRemoteSubagentTail } from './remote-subagent-tail'
import { RemoteFile, type RemoteFileRef } from './remote-ssh/remote-file'
import { childArgs } from '../core/remote-ssh/control-master'
import { posixQuote } from '../shared/ssh'
import { buildHandoff } from './handoff'
import { ChatDriver } from '../core/chat-driver'
import { initContextLink, setNodeTranscript } from '../core/context-link'
import { initCanvasControl, installCanvasSkillInto } from './canvas-control'
import { initTranscriptIndex, searchTranscripts } from '../core/transcript-index'
import { initTelemetry } from './telemetry'
import { initClaudeUsage } from './claude-usage'
import { initLicense, isPremium, getStoredEntitlement } from '../core/license'
import { initClaudeAccounts } from './claude-accounts'
import { claudeConfigDirFor } from '../core/claude-config-dir'
import { isSafeLocalTranscriptPath } from '../core/claude-accounts-core'
import { installClaudeHooksInto } from '../core/agents/hooks/claude'
import { createPairingService } from './pairing-service'
import {
  initRemoteHost,
  loadOrCreateKeyPair,
  relayAllowed,
  API_BASE as RELAY_API_BASE,
  RELAY_URL
} from './remote/host-service'
import { initStandingHost } from './remote/standing-host'
import { initRemoteClient } from './remote/client-service'
import { initSshProject } from './remote-ssh/ssh-project'
import { setGitRemoteResolver, type GitRemoteRef } from '../core/remote-ssh/remote-git'
import { SshFs } from './ssh-fs'
import {
  registerMediaScheme,
  initMediaProtocol,
  allowMediaPath,
  writeAgentHtml
} from './media-protocol'
import { initPlatform } from '../core/platform'
import { electronPlatform } from './platform-electron'

// Dev-only: NT_MULTI lets a SECOND instance run (host + client testing on one machine) with an
// isolated userData via NT_USER_DATA — its own device-id/session/license/workspace. Never active
// in packaged builds. Must run before the stores below resolve userData paths.
const NT_MULTI = !app.isPackaged && !!process.env.NT_MULTI
if (NT_MULTI && process.env.NT_USER_DATA) app.setPath('userData', process.env.NT_USER_DATA)

// First thing in bootstrap: install the Electron CorePlatform so anything in src/core
// (wired in later tasks) can resolve platform() at boot. Placed after the NT_MULTI
// userData override so userDataDir reads the final path; nothing consumes it yet.
initPlatform(electronPlatform())

// Only hand the OS a URL with a vetted scheme. Blocks file://, smb://, and custom
// protocol-handler schemes that could be smuggled in via remote announcement feeds or
// rendered markdown links. Used by both the window-open handler and the IPC handler.
function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

const settingsStore = new SettingsStore()
const sshStore = new SshStore()
const ptyManager = new PtyManager()
const workspaceStore = new WorkspaceStore()
const gitService = new GitService()
// One driver for all chat nodes. Resolves the live window at send time (getMainWindow) so
// pushes survive a macOS close→dock-reopen; disposed on quit next to ptyManager.killAll().
const chatDriver = new ChatDriver(getMainWindow, sendToMain)
// Set once the app window is ready; used by the quit hooks to tear down SSH-project masters.
let sshProjectManager: ReturnType<typeof initSshProject> | undefined

// Remote git routing is scoped to the ACTIVE project only (set via `git:set-active-remote`).
// A global cwd-keyed match would misroute when two SSH projects share a remote path, or when a
// LOCAL project's cwd equals a connected SSH project's remoteCwd. The renderer drives this on every
// project switch: the active SSH project's ref, or null for a local project (→ all git runs local).
let activeRemote: { cwd: string; ref: GitRemoteRef } | null = null

// The single app window is tracked in ./main-window (setMainWindow/getMainWindow) and
// resolved AT SEND TIME everywhere — a closure-captured window goes stale after the
// macOS close→dock-reopen cycle and silently swallows every send.
// True from the first before-quit on: lets window close-events through (see hide-on-close).
let quitting = false

// Browser <webview> guest webContents id → its browser node id (for new-window capture).
const browserGuests = new Map<number, string>()

// Node → live tail bookkeeping, so closing a node (× → pty:destroy) releases its file tailers.
// Without this, a node closed mid-run never emits SessionEnd/PostToolUse, so context-tail (1s
// poll) and subagent-tail (400ms poll) would keep stat/read-ing forever. Keyed by node id.
const nodeContextSession = new Map<string, string>() // nodeId → claude sessionId
const nodeSubagents = new Map<string, Set<string>>() // nodeId → active subagent tool_use_ids

// Enforce a single instance. A second instance would re-attach every node's tmux session
// (`new-session -A -D`), whose `-D` detaches the first instance's clients — leaving
// "[detached (from session ...)]" dead terminals. Bail out and focus the existing window
// instead. (This guards against a stray real GUI launch.)
const gotSingleInstanceLock = NT_MULTI || app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

// Declare the nt-media:// scheme privileged BEFORE the app is ready (required by Electron).
// The actual request handler is installed post-ready via initMediaProtocol().
registerMediaScheme()

// Raise the soft file-descriptor limit (macOS/Linux; no-op elsewhere). macOS launches GUI apps
// with a soft limit of 256, which a canvas full of terminals genuinely needs to exceed: every
// attached PTY holds a master fd here, plus hook-server sockets and transcript tails. 256 was
// hit in the field (posix_spawnp failures with ~34 terminals in one project).
if (process.platform !== 'win32' && typeof process.setFdLimit === 'function') {
  try {
    process.setFdLimit(8192)
  } catch (e) {
    console.warn('[main] could not raise fd limit', e)
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#1e1e1e',
    title: 'node-terminal',
    // Integrate the macOS traffic lights into our top bar (modern Mac app look).
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Enables the <webview> tag used by WebNode (embedded content stays locked down —
      // no nodeintegration is set on the webview element itself).
      webviewTag: true
    }
  })

  // Register as the live main window (send-time resolution via getMainWindow/sendToMain).
  setMainWindow(win)

  win.on('ready-to-show', () => win.show())

  // macOS: closing the window hides it instead of destroying it. The app deliberately
  // outlives its window (tmux sessions, hook server, updater); destroying the window
  // would leave every window-bound subsystem (agent-status forwarding, tails, updater,
  // license events) pointing at a dead webContents after a dock-reopen.
  win.on('close', (e) => {
    if (shouldHideOnClose(process.platform, quitting)) {
      e.preventDefault()
      win.hide()
    }
  })

  // Intercept Cmd/Ctrl+M (default = minimize) and route it to the renderer for the
  // markdown-view toggle instead.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.meta || input.control)) return
    const key = input.key.toLowerCase()
    if (key === 'm') {
      event.preventDefault()
      win.webContents.send(IPC.appToggleMarkdown)
    } else if (key === 'w' && !input.shift) {
      // Repurpose Cmd/Ctrl+W: the renderer closes the selected node(s); if none are
      // selected it asks us to close the window (the standard behavior).
      event.preventDefault()
      win.webContents.send(IPC.appCloseNode)
    }
  })

  // Open external links in the system browser — only safe schemes (no file://, no custom
  // protocol handlers). Reachable from remotely-fetched announcement URLs and rendered
  // markdown links, so the allowlist mirrors the shellOpenExternal IPC handler.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Block any in-page top-level navigation away from the app origin (defense in depth).
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? '\0')) {
      e.preventDefault()
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
    }
  })

  // Load the electron-vite dev server if present, otherwise the built file.
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return // losing second instance — quitting; don't touch tmux

  // Harden every <webview> guest (WebNode runs its page in its own webContents, so the main
  // window's setWindowOpenHandler / will-navigate above don't cover it). Registered once at
  // startup for all current and future guests.
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview') return
    // Web nodes may only show http(s) pages or local content we serve via the jailed
    // nt-media:// scheme.
    contents.on('will-navigate', (e, url) => {
      if (!/^https?:\/\//i.test(url) && !/^nt-media:\/\//i.test(url)) e.preventDefault()
    })
    // A browser node's guest requested a new window → open it as another browser node
    // (never a real popup). Only http(s); other schemes are dropped. The map is consulted
    // live at call time, so a guest registered later (on dom-ready) is seen when a popup fires.
    contents.setWindowOpenHandler(({ url }) => {
      const sourceNodeId = browserGuests.get(contents.id)
      if (sourceNodeId && /^https?:\/\//i.test(url)) {
        sendToMain(IPC.browserNewWindow, { url, sourceNodeId })
      }
      return { action: 'deny' }
    })
  })

  settingsStore.init()
  settingsStore.registerIpc()
  sshStore.registerIpc()
  ptyManager.init(() => settingsStore.get())
  ptyManager.registerIpc()
  workspaceStore.registerIpc()
  gitService.registerIpc()

  ipcMain.handle(IPC.commitGenerate, (_e, cwd: string) =>
    generateCommitMessage(cwd, settingsStore.get())
  )

  ipcMain.handle(IPC.mediaAllow, (_e, absPath: string) => allowMediaPath(absPath))
  ipcMain.handle(IPC.mediaWriteHtml, (_e, html: string) => writeAgentHtml(html))

  ipcMain.on(IPC.browserRegister, (_e, webContentsId: number, nodeId: string) => {
    browserGuests.set(webContentsId, nodeId)
  })
  ipcMain.on(IPC.browserUnregister, (_e, webContentsId: number) => {
    browserGuests.delete(webContentsId)
  })

  ipcMain.handle(IPC.ptyGenerateName, async (_e, persistKey: string, cwd: string) =>
    generateTerminalName(await ptyManager.captureSession(persistKey), cwd, settingsStore.get())
  )

  ipcMain.handle(IPC.ptyGenerateGroupName, async (_e, memberKeys: string[], cwd: string) => {
    const contents = await Promise.all(memberKeys.map((k) => ptyManager.captureSession(k)))
    return generateGroupName(contents, cwd, settingsStore.get())
  })

  ipcMain.handle(IPC.ptyCapture, (_e, persistKey: string, full?: boolean) =>
    ptyManager.captureSession(persistKey, full)
  )

  ipcMain.handle(IPC.ptyReadSessionName, (_e, sessionId: string, accountId?: string) =>
    readSessionName(sessionId ?? '', accountId)
  )

  ipcMain.on(IPC.appCloseWindow, () => BrowserWindow.getFocusedWindow()?.close())

  // Dock badge: number of Claude nodes with unread output (macOS only). '' clears it.
  ipcMain.on(IPC.appSetBadge, (_e, count: number) => {
    if (process.platform !== 'darwin' || !app.dock) return
    app.dock.setBadge(count > 0 ? String(count) : '')
  })

  // Show an OS notification — but only when the window is in the background. Clicking it
  // brings the app forward and asks the renderer to focus the originating node.
  // Resolves 'shown' | 'failed' | 'skipped' so the renderer can SEE a macOS permission
  // denial (UNErrorCodeNotificationsNotAllowed) instead of it dying silently — that broke
  // once already after an Electron upgrade invalidated the ncprefs signature record.
  ipcMain.handle(
    IPC.appNotify,
    async (_e, payload: { title: string; body: string; nodeId: string; force?: boolean }) => {
      const win = getMainWindow()
      if (!win || !Notification.isSupported()) return 'skipped'
      // `force` (permission request / confirmation) shows even when focused; normal
      // completion notifications only show when the window is in the background.
      if (!payload.force && win.isFocused()) return 'skipped'
      const n = new Notification({ title: payload.title, body: payload.body })
      n.on('click', () => {
        // Re-resolve at click time — the window may have been hidden/recreated since.
        const w = getMainWindow()
        if (!w) return
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
        if (payload.nodeId) w.webContents.send(IPC.appFocusNode, payload.nodeId)
      })
      // Without a retained reference the wrapper gets GC'd and the click handler dies —
      // clicking would then only activate the app, never focus the originating node.
      retainUntilDismissed(n)
      return await new Promise<'shown' | 'failed'>((resolve) => {
        // macOS reports delivery async; if neither event lands quickly, assume shown
        // (Windows/Linux never emit 'failed').
        const timer = setTimeout(() => resolve('shown'), 1500)
        n.on('show', () => {
          clearTimeout(timer)
          resolve('shown')
        })
        n.on('failed', (_ev, error) => {
          clearTimeout(timer)
          console.warn('[notify] OS rejected the notification:', error)
          resolve('failed')
        })
        n.show()
      })
    }
  )

  // Deep-link to the OS notification settings so the user can re-grant a denied
  // permission (macOS never re-prompts once the app's record exists). The URL is a
  // main-side constant — deliberately NOT routed through shellOpenExternal's
  // http(s)-only allowlist, which must stay closed to renderer-supplied strings.
  ipcMain.handle(IPC.appOpenNotificationSettings, () => {
    if (process.platform !== 'darwin') return
    void shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension')
  })

  ipcMain.handle(IPC.announcementsFetch, async () => (await fetchCheck()).messages)
  ipcMain.handle(IPC.appUpdatePolicy, async () => (await fetchCheck()).update)

  // Writable base dir for app-managed files (e.g. default git worktree location).
  ipcMain.handle(IPC.appUserDataDir, () => app.getPath('userData'))

  // Phone pairing (nodeterm iOS "scan a QR" flow): a one-shot LAN listener that installs the
  // phone's Ed25519 key into ~/.ssh/authorized_keys. The completion result is forwarded to the
  // window over `pairing:done` so the settings section can show the paired/timeout state.
  const pairingService = createPairingService({
    getSettings: () => settingsStore.get(),
    isPremium,
    getEntitlement: getStoredEntitlement,
    loadHostKeyPair: loadOrCreateKeyPair,
    relayEndpoint: RELAY_URL,
    apiBase: RELAY_API_BASE,
    relayAllowed
  })
  ipcMain.handle(IPC.pairingStart, () =>
    pairingService.start((result) => {
      const w = getMainWindow()
      if (w && !w.isDestroyed()) w.webContents.send(IPC.pairingDone, result)
    })
  )
  ipcMain.handle(IPC.pairingStop, () => pairingService.stop())
  ipcMain.handle(IPC.pairingListDevices, () => pairingService.listDevices())
  ipcMain.handle(IPC.pairingRevokeDevice, (_e, id: string) => pairingService.revokeDevice(id))

  ipcMain.on(IPC.shellReveal, (_e, p: string) => {
    if (p) shell.showItemInFolder(p)
  })

  ipcMain.on(IPC.shellOpenPath, (_e, p: string) => {
    if (p) void shell.openPath(p)
  })

  ipcMain.on(IPC.shellOpenExternal, (_e, url: string) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })

  // The local Explorer/Editor fs IPC: thin wrappers over the shared fs-ops (the SAME logic the
  // remote `fs.*` RPC handlers reuse, so local and remote filesystem behaviour stay identical).
  ipcMain.handle(IPC.fsList, (_e, dirPath: string) => fsOps.listDir(dirPath))
  ipcMain.handle(IPC.fsRead, (_e, filePath: string) => fsOps.readText(filePath))
  ipcMain.handle(IPC.fsReadBinary, (_e, filePath: string) => fsOps.readBinary(filePath))
  ipcMain.handle(IPC.fsWrite, (_e, filePath: string, content: string) =>
    fsOps.writeText(filePath, content)
  )
  ipcMain.handle(IPC.filesQuickOpen, (_e, cwd: string) => fsOps.listQuickOpenFiles(cwd))

  // SSH-project Explorer/Editor fs: the remote analog of the fs:* handlers above, scoped to a
  // project's ControlMaster. One SshFs bound to the SSH-project manager's own ssh runner (the SAME
  // runner RemoteFile reuses — just forwarding stdin so writes work), resolved lazily because
  // sshProjectManager is created below. The ref is looked up per call; a call before the manager
  // exists, or for an unconnected project, finds no ref and fails open ([]/''/false).
  const sshFs = new SshFs((args, stdin) =>
    sshProjectManager ? sshProjectManager.sshRun(args, stdin) : Promise.resolve({ code: 1, stdout: '' })
  )
  const sshFsRefFor = (projectId: string) => sshProjectManager?.refForProject(projectId)
  ipcMain.handle(IPC.sshFsList, (_e, projectId: string, p: string) => {
    const ref = sshFsRefFor(projectId)
    return ref ? sshFs.listDir(ref, p) : Promise.resolve([])
  })
  ipcMain.handle(IPC.sshFsRead, (_e, projectId: string, p: string) => {
    const ref = sshFsRefFor(projectId)
    return ref ? sshFs.readText(ref, p) : Promise.resolve('')
  })
  ipcMain.handle(IPC.sshFsReadBinary, (_e, projectId: string, p: string) => {
    const ref = sshFsRefFor(projectId)
    return ref ? sshFs.readBinary(ref, p) : Promise.resolve('')
  })
  ipcMain.handle(IPC.sshFsWrite, (_e, projectId: string, p: string, content: string) => {
    const ref = sshFsRefFor(projectId)
    return ref ? sshFs.writeText(ref, p, content) : Promise.resolve(false)
  })

  ipcMain.handle(IPC.dialogSelectFolder, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.dialogSelectFile, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  const win = createWindow()
  // Flip `quitting` before quitAndInstall so the window's close-event actually closes (not hides);
  // quitAndInstall closes all windows then calls app.quit(), which our hide-on-close would block.
  initUpdater(win, () => {
    quitting = true
  })
  // Mirror live agent status to <userData>/agent-status.json for the external mobile host agent.
  initAgentStatusMirror()

  // Agent hooks: install the managed hook script into each agent's config, then start the
  // local HTTP server that receives hook posts and forwards normalized events to the renderer.
  // A raw listener drives the transcript-tailing features (context meter + subagent transcript),
  // which need the raw transcript_path the NormalizedAgentEvent intentionally drops.
  const subagentTail = createSubagentTail(({ toolUseId, chunk }) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.agentSubagentActivity, { toolUseId, chunk })
  })
  // Async subagents (Claude's default) end via a <task-notification> queued into the PARENT
  // transcript — their PostToolUse is only a launch ack (see the raw listener below). The
  // context tails already read that transcript, so they surface the notification here and we
  // emit the synthetic subagent-end the hooks never send, then release the transcript tail.
  const onTaskNotification = (sessionId: string, n: TaskNotification): void => {
    let nodeId: string | undefined
    for (const [nid, sid] of nodeContextSession) if (sid === sessionId) nodeId = nid
    if (!nodeId) return
    const taskDoneEvent = {
      nodeId,
      agentId: 'claude',
      sessionId,
      kind: 'subagent-end',
      toolUseId: n.toolUseId,
      result: n.result
    } satisfies NormalizedAgentEvent
    sendToMain(IPC.agentStatus, taskDoneEvent)
    recordAgentEvent(taskDoneEvent)
    subagentTail.finish(n.toolUseId)
    remoteSubagentTail.untrack(n.toolUseId)
    nodeSubagents.get(nodeId)?.delete(n.toolUseId)
  }
  const contextTail = createContextTail((payload) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.contextUpdate, payload)
  }, { onTaskNotification })
  // Remote (SSH-project) counterparts: a node whose pty runs on a remote host has its Claude
  // transcript on that host, so its meter / subagent transcript / search must read over the
  // project's ControlMaster. One RemoteFile bound to the SSH-project manager's own ssh runner
  // (so reads reuse the live master); resolved lazily — sshProjectManager is created below but
  // these are only invoked once a remote hook POST arrives, long after init. Fail-open: a read
  // before the manager exists returns a non-zero code (RemoteFile maps that to empty).
  const remoteFile = new RemoteFile((args) =>
    sshProjectManager ? sshProjectManager.sshRun(args) : Promise.resolve({ code: 1, stdout: '' })
  )
  const remoteContextTail = createRemoteContextTail(win, remoteFile, { onTaskNotification })
  const remoteSubagentTail = createRemoteSubagentTail(win, remoteFile)
  // Remote transcript ref learned from the hook raw-listener, keyed by sessionId — lets the
  // search/chat read handlers (which receive only sessionId + cwd) read remotely without a
  // nodeId. Only remote sessions are ever inserted, so local reads stay on the local reader.
  const remoteTranscriptBySession = new Map<string, RemoteFileRef>()
  // toolUseIds whose remote subagent file resolution was cancelled (PostToolUse / node close
  // arrived before the file appeared) — checked by the async resolver to avoid a late track.
  // Bounded by `remoteSubagentResolving`: a cancel flag is only added (and only matters) while a
  // resolver is in flight, and the resolver clears BOTH sets in its `finally` once it settles, so
  // neither set can accumulate dead ids over the app lifetime.
  const remoteSubagentCancel = new Set<string>()
  // toolUseIds with an in-flight `resolveRemoteSubagentFile` poll. PostToolUse / node-close only
  // raise a cancel flag while resolution is still running (otherwise the add would leak).
  const remoteSubagentResolving = new Set<string>()

  // Resolve a remote subagent's transcript FILE (`agent-<id>.jsonl`) by matching the spawning
  // toolUseId inside its sibling `.meta.json` — the remote analogue of the local subagent tail's
  // dir scan (the remote tail takes a resolved file path, so we resolve it here). The file
  // appears shortly after PreToolUse, so we poll briefly over the master. Fail-open throughout.
  const resolveRemoteSubagentFile = async (
    rt: { conn: import('../shared/ssh').SshConnection; controlPath: string },
    parentTranscript: string,
    toolUseId: string
  ): Promise<string | undefined> => {
    if (!sshProjectManager) return undefined
    const dir = parentTranscript.replace(/\.jsonl$/, '') + '/subagents'
    // grep -lF prints the matching meta path; `… /*.meta.json` glob is left unquoted to expand.
    const cmd = `grep -lF ${posixQuote(toolUseId)} ${posixQuote(dir)}/*.meta.json 2>/dev/null | head -1`
    for (let i = 0; i < 12; i++) {
      if (remoteSubagentCancel.has(toolUseId)) return undefined
      const { stdout } = await sshProjectManager.sshRun(childArgs(rt.conn, rt.controlPath, cmd))
      const meta = stdout.trim()
      if (meta) return meta.replace(/\.meta\.json$/, '.jsonl')
      await new Promise((r) => setTimeout(r, 600))
    }
    return undefined
  }
  // Resolve a session's transcript path: prefer the exact session path when a (valid)
  // sessionId is known; otherwise fall back to the node's cwd, which is durable and doesn't
  // need a live hook event.
  const resolveTranscript = async (
    sessionId: string | undefined,
    cwd: string | undefined,
    accountId?: string
  ): Promise<string | undefined> => {
    let p: string | undefined
    if (sessionId && SESSION_ID_RE.test(sessionId)) {
      p = contextTail.pathFor(sessionId) ?? (await resolveTranscriptPath(sessionId, accountId))
    }
    if (!p && cwd) p = await transcriptPathForCwd(cwd)
    return p
  }

  // Read at most the last 5 MB of a transcript (mirrors transcript-reader's READ_CAP_BYTES) —
  // the remote read fetches the tail over ssh, then reuses the SAME pure parsers as local, so
  // the returned shape is byte-identical to the local reader.
  const REMOTE_TRANSCRIPT_CAP = 5 * 1024 * 1024
  ipcMain.handle(
    IPC.claudeReadTranscript,
    async (
      _e,
      sessionId: string | undefined,
      cwd: string | undefined,
      accountId: string | undefined
    ) => {
      const ref = sessionId ? remoteTranscriptBySession.get(sessionId) : undefined
      if (ref) {
        const text = await remoteFile.readTail(ref, REMOTE_TRANSCRIPT_CAP)
        return parseTranscriptLines(text)
      }
      const p = await resolveTranscript(sessionId, cwd, accountId)
      return p ? readTranscriptLines(p) : []
    }
  )

  ipcMain.handle(
    IPC.chatReadTranscript,
    async (
      _e,
      sessionId: string | undefined,
      cwd: string | undefined,
      accountId: string | undefined
    ) => {
      const ref = sessionId ? remoteTranscriptBySession.get(sessionId) : undefined
      if (ref) {
        const text = await remoteFile.readTail(ref, REMOTE_TRANSCRIPT_CAP)
        return parseChatMessages(text.split('\n'))
      }
      const p = await resolveTranscript(sessionId, cwd, accountId)
      return p ? readChatMessages(p) : []
    }
  )

  initTranscriptIndex(() => settingsStore.get().claudeAccounts ?? [])
  ipcMain.handle(IPC.transcriptSearch, (_e, query: string) => searchTranscripts(query))
  // Populate the context meter without a live hook event: the renderer calls this on mount
  // (the continuing session may be idle after a restart). Track under the sessionId (the key
  // the meter looks up); cwd is only a path fallback. contextTail.track reads immediately and
  // the 1s interval keeps it fresh while tracked.
  ipcMain.on(
    IPC.contextEnsure,
    async (_e, sessionId?: string, cwd?: string, accountId?: string) => {
      if (!sessionId || !SESSION_ID_RE.test(sessionId)) return
      let p = contextTail.pathFor(sessionId) ?? (await resolveTranscriptPath(sessionId, accountId))
      if (!p && cwd) p = await transcriptPathForCwd(cwd)
      if (p) contextTail.track(sessionId, p)
    }
  )
  ipcMain.handle(
    IPC.handoffBuild,
    (
      _e,
      sessionId: string,
      agentId: string,
      sourceNodeId: string,
      cwd: string | undefined,
      accountId: string | undefined
    ) => buildHandoff({ sessionId, agentId, sourceNodeId, cwd, accountId })
  )
  // Chat nodes: one long-lived Claude Agent SDK query per node, bridged over chat:* IPC.
  ipcMain.handle(IPC.chatEnsure, (_e, nodeId: string, opts) => chatDriver.ensure(nodeId, opts))
  ipcMain.on(IPC.chatSend, (_e, nodeId: string, text: string, images) => chatDriver.send(nodeId, text, images))
  ipcMain.on(IPC.chatInterrupt, (_e, nodeId: string) => chatDriver.interrupt(nodeId))
  ipcMain.on(IPC.chatPermissionReply, (_e, nodeId: string, requestId: string, decision) =>
    chatDriver.permissionReply(nodeId, requestId, decision))
  ipcMain.on(IPC.chatRemoveQueued, (_e, nodeId: string, queueId: string) => chatDriver.removeQueued(nodeId, queueId))
  ipcMain.on(IPC.chatDispose, (_e, nodeId: string) => chatDriver.dispose(nodeId))

  installManagedAgentHooks()
  // Managed accounts each carry their own settings.json AND skills/ (Claude Code resolves both
  // relative to CLAUDE_CONFIG_DIR) — re-install the hook + canvas skill there too (idempotent),
  // so an app update's new versions reach every account dir. Best-effort: one failing account
  // must never block launch (match installManagedAgentHooks' fail-open).
  for (const acct of settingsStore.get().claudeAccounts ?? []) {
    if (acct.host) continue // remote accounts live on another host; nothing to install locally
    try {
      installClaudeHooksInto(claudeConfigDirFor(acct.id))
      installCanvasSkillInto(claudeConfigDirFor(acct.id))
    } catch (e) {
      console.warn(`[agent-hooks] account ${acct.id} hook install failed`, e)
    }
  }
  hookServer.setListener((e) => {
    sendToMain(IPC.agentStatus, e)
    recordAgentEvent(e)
  })
  // Security: hook POSTs now arrive over the remote reverse tunnel too (SSH Phase 2a), so a
  // forged/remote POST could set transcript_path to an arbitrary LOCAL path (e.g. ~/.ssh/id_rsa)
  // and have the app read it. The tails read the LOCAL filesystem; legitimate LOCAL transcripts
  // live under the system default `~/.claude/projects` OR a managed account's
  // `{userData}/claude-accounts/<id>/projects` (id-validated so a forged POST can't traverse out
  // — see isSafeLocalTranscriptPath). Phase 2a does NOT tail remote transcripts (that's 2b), so we
  // jail transcript_path to those roots and skip the read otherwise. Returns the path only when it
  // resolves under an allowed root.
  const safeTranscriptPath = (tp: string | undefined): string | undefined => {
    if (!tp) return undefined
    const abs = resolve(tp)
    return isSafeLocalTranscriptPath(abs, homedir(), app.getPath('userData')) ? abs : undefined
  }
  // Remote analogue of safeTranscriptPath: a remote node's transcript_path is a remote absolute
  // path arriving over the reverse tunnel — a forged POST must not read an arbitrary remote file.
  // Jail it under the project's remote `<remoteHome>/.claude/projects` using POSIX semantics
  // (remote hosts are POSIX). The `+ '/'` boundary rejects sibling-prefix paths (…/projects-evil).
  const safeRemoteTranscriptPath = (
    tp: string | undefined,
    remoteHome: string | undefined
  ): string | undefined => {
    if (!tp || !remoteHome) return undefined
    const root = posix.join(remoteHome, '.claude', 'projects')
    const abs = posix.resolve(tp)
    return abs === root || abs.startsWith(root + '/') ? abs : undefined
  }
  const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
  hookServer.setRawListener((agentId, nodeId, payload) => {
    if (agentId !== 'claude') return
    const p = payload as {
      hook_event_name?: string
      session_id?: string
      transcript_path?: string
      tool_name?: string
      tool_use_id?: string
      tool_response?: { status?: string; isAsync?: boolean }
    }
    // An async subagent's PostToolUse is only the launch ack — keep tailing its transcript;
    // the real end (task-notification via the context tails) releases it.
    const asyncLaunch = p.hook_event_name === 'PostToolUse' && isAsyncSubagentLaunch(p.tool_response)
    // REMOTE node: route to the remote tails/search, jailing the path under the project's remote
    // ~/.claude/projects. Diverges from the local path ONLY when the node has a live ssh remote.
    const rt = nodeId ? ptyManager.sshRemoteForNode(nodeId) : undefined
    if (rt) {
      const remoteHome = sshProjectManager?.remoteHomeForControlPath(rt.controlPath)
      const transcriptPath = safeRemoteTranscriptPath(p.transcript_path, remoteHome)
      if (p.session_id && transcriptPath) {
        const ref: RemoteFileRef = { conn: rt.conn, controlPath: rt.controlPath, path: transcriptPath }
        remoteContextTail.track(p.session_id, ref)
        remoteTranscriptBySession.set(p.session_id, ref)
      }
      if (nodeId && p.session_id) nodeContextSession.set(nodeId, p.session_id)
      if (p.hook_event_name === 'SessionEnd' && p.session_id) {
        remoteContextTail.untrack(p.session_id)
        remoteTranscriptBySession.delete(p.session_id)
      }
      if (p.tool_use_id && p.tool_name && SUBAGENT_TOOLS.has(p.tool_name) && transcriptPath) {
        const toolUseId = p.tool_use_id
        if (p.hook_event_name === 'PreToolUse') {
          remoteSubagentCancel.delete(toolUseId)
          remoteSubagentResolving.add(toolUseId)
          // Resolve the remote subagent file asynchronously (it appears shortly after), then track.
          // The `finally` always clears both bookkeeping sets so they can't accumulate dead ids.
          void resolveRemoteSubagentFile(rt, transcriptPath, toolUseId)
            .then((file) => {
              if (file && !remoteSubagentCancel.has(toolUseId)) {
                remoteSubagentTail.track(toolUseId, { conn: rt.conn, controlPath: rt.controlPath, path: file })
              }
            })
            .finally(() => {
              remoteSubagentResolving.delete(toolUseId)
              remoteSubagentCancel.delete(toolUseId)
            })
          if (nodeId) {
            const set = nodeSubagents.get(nodeId) ?? new Set<string>()
            set.add(toolUseId)
            nodeSubagents.set(nodeId, set)
          }
        } else if (p.hook_event_name === 'PostToolUse' && !asyncLaunch) {
          // Only cancel an in-flight resolve; if it already settled, adding here would leak.
          if (remoteSubagentResolving.has(toolUseId)) remoteSubagentCancel.add(toolUseId)
          remoteSubagentTail.untrack(toolUseId)
          if (nodeId) nodeSubagents.get(nodeId)?.delete(toolUseId)
        }
      }
      // Session over → release any still-tracked async subagent tails for this node.
      if (p.hook_event_name === 'SessionEnd' && nodeId) {
        for (const toolUseId of nodeSubagents.get(nodeId) ?? []) {
          if (remoteSubagentResolving.has(toolUseId)) remoteSubagentCancel.add(toolUseId)
          remoteSubagentTail.untrack(toolUseId)
        }
        nodeSubagents.delete(nodeId)
      }
      return
    }
    const transcriptPath = safeTranscriptPath(p.transcript_path)
    // Context-window meter: tail the session transcript (any event carrying both fields).
    if (p.session_id && transcriptPath) contextTail.track(p.session_id, transcriptPath)
    if (nodeId && p.session_id) nodeContextSession.set(nodeId, p.session_id)
    if (nodeId && p.session_id && transcriptPath) setNodeTranscript(nodeId, p.session_id, transcriptPath)
    if (p.hook_event_name === 'SessionEnd' && p.session_id) contextTail.untrack(p.session_id)
    // Subagent live transcript: track on PreToolUse / finish on PostToolUse for subagent tools.
    if (p.tool_use_id && p.tool_name && SUBAGENT_TOOLS.has(p.tool_name)) {
      if (p.hook_event_name === 'PreToolUse') {
        subagentTail.track(p.tool_use_id, transcriptPath)
        if (nodeId) {
          const set = nodeSubagents.get(nodeId) ?? new Set<string>()
          set.add(p.tool_use_id)
          nodeSubagents.set(nodeId, set)
        }
      } else if (p.hook_event_name === 'PostToolUse' && !asyncLaunch) {
        subagentTail.finish(p.tool_use_id)
        if (nodeId) nodeSubagents.get(nodeId)?.delete(p.tool_use_id)
      }
    }
    // Session over → release any still-tracked async subagent tails for this node (their
    // task-notifications will never arrive once the session is gone).
    if (p.hook_event_name === 'SessionEnd' && nodeId) {
      for (const toolUseId of nodeSubagents.get(nodeId) ?? []) subagentTail.finish(toolUseId)
      nodeSubagents.delete(nodeId)
    }
  })

  // Releasing tails on node close: pty:destroy fires when the user clicks × (persistKey = node
  // id). pty-manager already handles the same channel to kill the tmux session; this extra
  // listener tears down the per-node file tailers so they stop polling a now-dead session.
  ipcMain.on(IPC.ptyDestroy, (_e, nodeId: string) => {
    const sessionId = nodeContextSession.get(nodeId)
    if (sessionId) {
      // Untrack both tails — untracking a non-tracked session is a no-op, so this is safe
      // regardless of whether the closed node was local or remote (avoids an ordering race
      // with pty-manager's own ptyDestroy handler clearing the ssh-remote registration).
      contextTail.untrack(sessionId)
      remoteContextTail.untrack(sessionId)
      remoteTranscriptBySession.delete(sessionId)
      nodeContextSession.delete(nodeId)
    }
    const subs = nodeSubagents.get(nodeId)
    if (subs) {
      for (const toolUseId of subs) {
        subagentTail.finish(toolUseId)
        // Only cancel an in-flight resolve; if it already settled, adding here would leak.
        if (remoteSubagentResolving.has(toolUseId)) remoteSubagentCancel.add(toolUseId)
        remoteSubagentTail.untrack(toolUseId)
      }
      nodeSubagents.delete(nodeId)
    }
  })
  // Agent canvas control: the spawned agent's `nodeterm` CLI POSTs a verb to the hook server,
  // which we forward to the renderer and await a reply. A pending-request map (keyed by a random
  // requestId) bridges the two async hops; both the reply and the 120s timeout clear the entry.
  const pendingControl = new Map<
    string,
    {
      resolve: (r: { ok: boolean; message?: string; result?: unknown; error?: string }) => void
      timer: NodeJS.Timeout
    }
  >()
  ipcMain.on(
    IPC.agentControlResult,
    (
      _e,
      payload: { requestId: string; ok: boolean; message?: string; result?: unknown; error?: string }
    ) => {
      const pending = pendingControl.get(payload.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      pendingControl.delete(payload.requestId)
      pending.resolve(payload)
    }
  )
  hookServer.setControlHandler(async ({ verb, nodeId, args }) => {
    const target = getMainWindow()
    if (!target) return { ok: false, error: 'window unavailable' }
    const requestId = randomUUID()
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingControl.delete(requestId)
        resolve({ ok: false, error: 'timed out (no response / not confirmed)' })
      }, 120_000)
      pendingControl.set(requestId, { resolve, timer })
      target.webContents.send(IPC.agentControl, { requestId, sourceNodeId: nodeId, verb, args })
    })
  })
  await hookServer.start()
  initMediaProtocol()

  initContextLink(ptyManager)
  initCanvasControl()
  initClaudeUsage(win)
  initTelemetry(() => settingsStore.get())
  initLicense()
  // Lazy getter: sshProjectManager is created just below, so a remote account op (which only runs
  // after the user has connected an SSH project) always sees the live manager.
  initClaudeAccounts(() => sshProjectManager)
  initRemoteHost(win, ptyManager)
  // Standing (phone) relay host: keep a host connection registered so a paired phone can reach
  // this Mac from anywhere. Honors settings.phoneAccessEnabled + the Pro gate internally.
  const standingHost = initStandingHost(win, ptyManager, () => settingsStore.get())
  ipcMain.on(IPC.remoteStandingHostSet, (_e, enabled: boolean) => standingHost.setEnabled(!!enabled))
  // Reconcile from persisted settings on launch (starts hosting if enabled + Pro).
  standingHost.syncFromSettings()
  initRemoteClient(win, { isPackaged: app.isPackaged })
  sshProjectManager = initSshProject(win)
  // Route git-service + commit-message git ops over the active SSH project's master only — and only
  // for that project's exact remoteCwd. Any other cwd (a local project, or a different connected
  // project) resolves to undefined, so the local path stays byte-identical.
  setGitRemoteResolver((cwd) => (activeRemote && activeRemote.cwd === cwd ? activeRemote.ref : undefined))
  // The renderer's active-project effect calls this on every switch: a non-null projectId of a
  // connected SSH project (whose ref carries a remoteCwd) arms remote routing; null/local disarms it.
  ipcMain.handle(IPC.gitSetActiveRemote, (_e, projectId: string | null) => {
    const ref = projectId ? sshProjectManager?.refForProject(projectId) : undefined
    activeRemote =
      ref && ref.remoteCwd
        ? { cwd: ref.remoteCwd, ref: { conn: ref.conn, controlPath: ref.controlPath } }
        : null
  })

  app.on('activate', () => {
    // With hide-on-close the window usually still exists — just re-show it. Only a truly
    // gone window (e.g. renderer crash) is recreated; createWindow re-registers it as the
    // main window, so send-time resolution keeps agent-status forwarding alive.
    const existing = getMainWindow()
    if (existing) {
      existing.show()
      existing.focus()
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // On macOS the app stays alive, so the async final snapshots inside killAll can complete
  // in the background; on other platforms quitting goes through before-quit below.
  if (process.platform !== 'darwin') {
    app.quit()
  } else {
    void ptyManager.killAll()
    sshProjectManager?.disconnectAll()
  }
})

// The final scrollback snapshots are async (capture subprocess + fs.promises write) — hold
// the quit just long enough for them to land, capped so a hung tmux can never block quit.
let quitFlushed = false
app.on('before-quit', (e) => {
  quitting = true // from here on, window close-events must NOT be turned into hide
  sshProjectManager?.disconnectAll()
  chatDriver.disposeAll() // tear down every chat node's SDK query (resume-based, so this is safe)
  if (quitFlushed) return
  quitFlushed = true
  e.preventDefault()
  const flush = ptyManager.killAll()
  void Promise.race([flush, new Promise((r) => setTimeout(r, 1500))]).finally(() => app.quit())
})
