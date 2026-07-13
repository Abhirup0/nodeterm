import { join, resolve, posix } from 'path'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { IPC } from '../shared/ipc'
import { registerFsHandlers } from '../core/fs-handlers'
import { PtyManager } from '../core/pty-manager'
import { WorkspaceStore } from '../core/workspace-store'
import { WorkspaceWatcher } from '../core/workspace-watcher'
import { SettingsStore } from '../core/settings-store'
import { presenceHub } from '../core/presence/hub'
import { SshStore } from './ssh-store'
import { GitService } from '../core/git-service'
import { generateCommitMessage, generateGroupName, generateTerminalName } from '../core/commit-message'
import { initUpdater } from './updater'
import { fetchCheck } from '../core/check'
import { hookServer } from '../core/agents/hook-server'
import { setMainWindow, getMainWindow, sendToMain, shouldHideOnClose } from './main-window'
import { initAgentStatusMirror, recordAgentEvent } from '../core/agent-status-mirror'
import { initCanvasSync } from '../core/canvas-sync'
import { retainUntilDismissed } from './notifications'
import { installManagedAgentHooks } from '../core/agents/hooks'
import { createSubagentTail } from '../core/subagent-tail'
import { createContextTail, type TaskNotification } from '../core/context-tail'
import { isAsyncSubagentLaunch, type NormalizedAgentEvent } from '../shared/agents/normalize'
import {
  readTranscriptLines,
  readChatMessages,
  readSessionName,
  setRemoteTranscriptReader,
  TITLE_TAIL_BYTES,
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
import { claudeCliCaps, registerClaudeCliIpc } from '../core/claude-cli'
import { claudeConfigDirFor } from '../core/claude-config-dir'
import { isSafeLocalTranscriptPath, isSafeRemoteTranscriptPath } from '../core/claude-accounts-core'
import { installClaudeHooksInto, ensureClaudeFullscreenTuiInto } from '../core/agents/hooks/claude'
import { createPairingService } from './pairing-service'
import {
  initRemoteHost,
  loadOrCreateKeyPair,
  relayAllowed,
  API_BASE as RELAY_API_BASE,
  RELAY_URL
} from './remote/host-service'
import { initStandingHost } from './remote/standing-host'
import { killRelayHostsByPeerKey } from './remote/relay-host'
import { initRelayHost } from './remote/relay-host-service'
import { createRevoker } from './remote/revocation'
import { loadApprovedDevices, saveApprovedDevices } from './remote/approved-devices'
import { initRemoteClient } from './remote/client-service'
import { initSshProject } from './remote-ssh/ssh-project'
import { setGitRemoteResolver, type GitRemoteRef } from '../core/remote-ssh/remote-git'
import { SshFs } from './ssh-fs'
import { makeRemoteWorkspaceIO } from './remote-workspace-io'
import {
  registerMediaScheme,
  initMediaProtocol,
  allowMediaPath,
  writeAgentHtml
} from './media-protocol'
import { initPlatform } from '../core/platform'
import { electronPlatform } from './platform-electron'
import { wirePeerRegistry } from './peer-registry'

// Dev-only: NT_MULTI lets a SECOND instance run (host + client testing on one machine) with an
// isolated userData via NT_USER_DATA — its own device-id/session/license/workspace. Never active
// in packaged builds. Must run before the stores below resolve userData paths.
const NT_MULTI = !app.isPackaged && !!process.env.NT_MULTI
if (NT_MULTI && process.env.NT_USER_DATA) app.setPath('userData', process.env.NT_USER_DATA)

// First thing in bootstrap: install the Electron CorePlatform so anything in src/core
// (wired in later tasks) can resolve platform() at boot. Placed after the NT_MULTI
// userData override so userDataDir reads the final path; nothing consumes it yet.
// Held: a relay peer's inbound RPC is answered from THIS instance's handler table (corePlatform
// .dispatch / .cast — see platform-electron.ts). `platform()` only exposes the CorePlatform half.
const corePlatform = electronPlatform()
initPlatform(corePlatform)

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

// Relay PEER sinks (docs/remote-sessions.md 4b) — the desktop mirror of src/server/index.ts's
// setFlowController / setResyncProvider / onClientGone. Wired at boot, BEFORE any peer can register
// (4c), because a peer that leaves must hand its pty subscriptions back: `unregisterPeerSink` calls
// `onPeerGone` → `dropClient`, and nothing else tells the pty layer that subscriber is gone (a
// vanished peer sends no `pty:kill`) — the pause it owed would freeze the shared terminal for every
// viewer. Inert with zero peers: the registry holds no sink, so none of this ever runs.
// Wired once here — do not double-wire (4b Task 4). A second wirePeerRegistry() call would silently
// overwrite these deps (last write wins), so keep this the sole call site in src/main.
wirePeerRegistry({
  setFlow: (id, sid, resume, owner) => ptyManager.setFlow(id, sid, resume, owner),
  captureForResync: (sid) => ptyManager.captureForResync(sid),
  onPeerGone: (id) => ptyManager.dropClient(id)
})

// Set once the app window is ready; used by the quit hooks to tear down SSH-project masters and
// (via the closures below) to resolve a live SSH project's ControlMaster for remote workspace IO.
let sshProjectManager: ReturnType<typeof initSshProject> | undefined
// Remote SSH IO for the workspace store: mirrors each SSH project's <remoteCwd>/.nodeterm/project.json
// over that project's live master. Resolves the ref lazily — the manager is created after the window
// is ready — and fails open (no-op) while the project is disconnected.
const workspaceSshFs = new SshFs((args, stdin) =>
  sshProjectManager ? sshProjectManager.sshRun(args, stdin) : Promise.resolve({ code: 1, stdout: '' })
)
const workspaceStore = new WorkspaceStore(
  makeRemoteWorkspaceIO((projectId) => sshProjectManager?.refForProject(projectId) ?? null, workspaceSshFs)
)
// Watch each local ref's project.json for outside edits (git pull, a teammate's commit).
// Self-writes match the store's last-written cache and are ignored. Re-synced after every
// store load/save via onPersist; disposed on quit next to ptyManager.killAll().
const workspaceWatcher = new WorkspaceWatcher({
  paths: () => workspaceStore.localRefPaths(),
  isSelfWrite: (p, c) => workspaceStore.isSelfWrite(p, c),
  onExternalChange: (filePath) => {
    void workspaceStore.readLocalRefByPath(filePath).then((changed) => {
      if (changed) sendToMain(IPC.workspaceExternalChange, changed)
    })
  }
})
workspaceStore.onPersist = () => workspaceWatcher.sync()
const gitService = new GitService()
// One driver for all chat nodes. Resolves the live window at send time (getMainWindow) so
// pushes survive a macOS close→dock-reopen; disposed on quit next to ptyManager.killAll().
const chatDriver = new ChatDriver(getMainWindow, sendToMain)

// Markers delimiting the `projects.list` relay blob. The iOS client splits on these exact
// strings to recover [workspace.json | newline-joined tmux session names | agent-status.json],
// matching the SSH browse pipeline it already uses — keep them in sync with NodetermProjects.swift.
const NT_PROJECTS_MARK = '--NT-PROJECTS-SPLIT--'
const NT_STATUS_MARK = '--NT-STATUS-SPLIT--'

/**
 * Build the marker-delimited projects blob served over the relay's `projects.list` RPC. Reads the
 * same files the SSH browse path reads locally on the host (no SSH): `workspace.json` +
 * `agent-status.json` under userData, plus the live nodeterm tmux session names. Every read is
 * best-effort (missing files degrade to an empty section) so this never throws.
 */
async function listProjectsOutput(): Promise<string> {
  const dir = app.getPath('userData')
  // Serve the ASSEMBLED v2-shaped workspace, never the raw workspace.json. Post-migration the file
  // is a v3 index ({version:3, entries:[…]}) whose local-ref entries hold no node data at all — the
  // paired iOS client decodes `{ projects: [Project] }`, so a raw v3 file lists zero projects.
  // load() re-reads each ref's .nodeterm/project.json and returns {version:2, projects:[…]}; it is
  // idempotent (and re-syncs the watcher via onPersist), so calling it here is safe.
  const workspace = await workspaceStore
    // Read-only: a phone listing projects mid git-merge must NOT sideline a conflict-marked
    // project.json to `.corrupt-<ts>` (the probe/watcher-path fix); sideline is boot/renderer-only.
    .load({ sideline: false })
    .then((w) => JSON.stringify(w))
    .catch(() => '')
  const status = await readFile(join(dir, 'agent-status.json'), 'utf8').catch(() => '')
  const sessions = (await ptyManager.listNodetermSessions().catch(() => [])).join('\n')
  return `${workspace}\n${NT_PROJECTS_MARK}\n${sessions}\n${NT_STATUS_MARK}\n${status}`
}

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

  // Team presence: this window is one peer. With nobody else connected the renderer draws nothing
  // (≤1 peer = zero cost); it matters when a phone joins over the relay, or when this desktop
  // hosts. Its ClientId is the webContents id — the same id space sendTo/handleWithSender use.
  // `closed` (not `close` — which only hides the window on macOS) is the real departure.
  // (The id is captured up front: reading `win.webContents` after 'closed' throws — the window and
  // its webContents are destroyed by then.)
  const presenceId = win.webContents.id
  presenceHub.join(presenceId, 'desktop')
  win.on('closed', () => {
    presenceHub.leave(presenceId)
    // This webContents is a pty SUBSCRIBER (co-attach: one pty, N subscribers, keyed by the
    // webContents id). A destroyed window sends no `pty:kill`, so without this it would stay
    // subscribed forever: the pty client is never released, the detach-time scrollback snapshot
    // is skipped, and a session it had paused via flow control could never be resumed — the next
    // client to co-attach to that node would inherit a frozen terminal. The tmux sessions
    // themselves keep running, exactly as they do on quit (killAll).
    ptyManager.dropClient(presenceId)
  })
  // A crashed/killed renderer is the same story, minus the window: drop its subscriptions so the
  // reloaded renderer reattaches to live sessions instead of inheriting the dead one's state.
  win.webContents.on('render-process-gone', () => ptyManager.dropClient(presenceId))

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
  presenceHub.registerIpc()
  registerClaudeCliIpc()
  // Warm the `claude --version` probe now (it spawns a login shell + node, ~sub-second) so the
  // renderer's first `claude.cliCaps()` — awaited on the launch path of a cold-restored agent
  // node — resolves from cache instead of racing the probe into a conservative "no auto".
  void claudeCliCaps()

  // REACHABILITY (4c): a handler registered through `corePlatform` serves BOTH the local window
  // (it is still `ipcMain.handle`, bit-for-bit) AND a relay peer (answered from the platform's
  // handler table — a peer has no webContents, so a raw `ipcMain.handle` is invisible to it).
  // Everything core-bound — it acts on THIS machine's state, which is exactly what a remote tab
  // is looking at — goes on the platform. The raw `ipcMain` registrations that remain further down
  // are deliberate: each one must act on the USER's machine (dialogs, shell, notifications,
  // updater) or is part of the host's own trust/relay control plane (pairing, remote:*, accounts).
  corePlatform.handle(IPC.commitGenerate, (cwd: string) =>
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

  // The naming agent runs LOCALLY on captured output, so it needs a cwd that exists on THIS
  // machine. An SSH-project node's `data.cwd` is a path on the REMOTE host — spawning there fails
  // (ENOENT) and the ✦ button silently did nothing. The cwd carries no meaning for naming (the
  // terminal output is in the prompt), so a remote node falls back to '' → runAgent's os.homedir().
  const localNamingCwd = (keys: string[], cwd: string): string =>
    keys.some((k) => ptyManager.sshRemoteForNode(k)) ? '' : cwd

  corePlatform.handle(IPC.ptyGenerateName, async (persistKey: string, cwd: string) =>
    generateTerminalName(
      await ptyManager.captureSession(persistKey),
      localNamingCwd([persistKey], cwd),
      settingsStore.get()
    )
  )

  corePlatform.handle(IPC.ptyGenerateGroupName, async (memberKeys: string[], cwd: string) => {
    const contents = await Promise.all(memberKeys.map((k) => ptyManager.captureSession(k)))
    return generateGroupName(contents, localNamingCwd(memberKeys, cwd), settingsStore.get())
  })

  corePlatform.handle(IPC.ptyCapture, (persistKey: string, full?: boolean) =>
    ptyManager.captureSession(persistKey, full)
  )

  corePlatform.handle(IPC.ptyReadSessionName, (sessionId: string, accountId?: string) =>
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

  // Writable base dir for app-managed files (e.g. default git worktree location). On the platform:
  // a remote tab derives the default worktree path from it, and the worktree lives on THIS host.
  corePlatform.handle(IPC.appUserDataDir, () => app.getPath('userData'))

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

  // Revoking a bridged PEER must CUT THE LIVE SESSION, not just unpin it (revocation.ts): unpinning
  // refuses only the NEXT handshake, while the open relay socket keeps full shell access — "the
  // person I just removed is still sitting in my terminal, typing". `killByPeerKey` closes every
  // live session with that key, and each close runs the peer teardown (presence leave →
  // PtyManager.dropClient → sink prune). Host-security control plane, so it stays on raw ipcMain:
  // a remote peer must never be able to revoke anyone.
  const peerRevoker = createRevoker({
    load: loadApprovedDevices,
    save: saveApprovedDevices,
    onRevoke: (peerKeyB64) => killRelayHostsByPeerKey(peerKeyB64)
  })
  ipcMain.handle(IPC.remoteRevokePeer, (_e, peerKeyB64: string) =>
    peerRevoker.revoke(String(peerKeyB64))
  )

  ipcMain.on(IPC.shellReveal, (_e, p: string) => {
    if (p) shell.showItemInFolder(p)
  })

  ipcMain.on(IPC.shellOpenPath, (_e, p: string) => {
    if (p) void shell.openPath(p)
  })

  ipcMain.on(IPC.shellOpenExternal, (_e, url: string) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })

  // The Explorer/Editor fs surface: ONE registrar (core/fs-handlers.ts) shared by this shell and
  // the Server Edition, over the same pure core/fs-ops — so local, browser and peer filesystem
  // behaviour cannot drift. Registered on the platform, so a remote tab's Explorer/editor works.
  registerFsHandlers(corePlatform)

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
  ipcMain.handle(IPC.sshFsMkdir, (_e, projectId: string, p: string) => {
    const ref = sshFsRefFor(projectId)
    return ref ? sshFs.mkdir(ref, p) : Promise.resolve(false)
  })
  ipcMain.handle(IPC.sshFsExists, (_e, projectId: string, p: string) => {
    const ref = sshFsRefFor(projectId)
    return ref ? sshFs.exists(ref, p) : Promise.resolve(false)
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
  // Canvas sync: the same reflector the Server Edition boots. With a single window clientIds()
  // returns one id, so on the desktop today it is a no-op — wired for parity (and for the
  // relay-host / multi-window futures), not because Electron needs it right now.
  initCanvasSync()

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
  // Route the session-name read (the node-title poll) through the same remote ref. An SSH
  // project's agent runs on the remote host, so its transcript is NOT under the local
  // `~/.claude/projects` — without this, `/rename` never reached the node title on remote nodes
  // (and the poll re-scanned the local root every 4s for nothing). Returning null for an unknown
  // sessionId keeps every local node on the local reader.
  setRemoteTranscriptReader(async (sessionId) => {
    const ref = remoteTranscriptBySession.get(sessionId)
    if (!ref) return null
    return { text: await remoteFile.readTail(ref, TITLE_TAIL_BYTES) }
  })
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
  corePlatform.handle(
    IPC.claudeReadTranscript,
    async (
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

  corePlatform.handle(
    IPC.chatReadTranscript,
    async (
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
  corePlatform.handle(IPC.transcriptSearch, (query: string) => searchTranscripts(query))
  // Populate the context meter without a live hook event: the renderer calls this on mount
  // (the continuing session may be idle after a restart). Track under the sessionId (the key
  // the meter looks up); cwd is only a path fallback. contextTail.track reads immediately and
  // the 1s interval keeps it fresh while tracked.
  corePlatform.on(IPC.contextEnsure, async (sessionId?: string, cwd?: string, accountId?: string) => {
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) return
    let p = contextTail.pathFor(sessionId) ?? (await resolveTranscriptPath(sessionId, accountId))
    if (!p && cwd) p = await transcriptPathForCwd(cwd)
    if (p) contextTail.track(sessionId, p)
  })
  corePlatform.handle(
    IPC.handoffBuild,
    (
      sessionId: string,
      agentId: string,
      sourceNodeId: string,
      cwd: string | undefined,
      accountId: string | undefined
    ) => buildHandoff({ sessionId, agentId, sourceNodeId, cwd, accountId })
  )
  // Chat nodes: one long-lived Claude Agent SDK query per node, bridged over chat:* IPC. On the
  // platform: the driver runs on THIS host, and a remote tab's chat node drives the same one.
  corePlatform.handle(IPC.chatEnsure, (nodeId: string, opts) => chatDriver.ensure(nodeId, opts))
  corePlatform.on(IPC.chatSend, (nodeId: string, text: string, images) =>
    chatDriver.send(nodeId, text, images))
  corePlatform.on(IPC.chatInterrupt, (nodeId: string) => chatDriver.interrupt(nodeId))
  corePlatform.on(IPC.chatPermissionReply, (nodeId: string, requestId: string, decision) =>
    chatDriver.permissionReply(nodeId, requestId, decision))
  corePlatform.on(IPC.chatRemoveQueued, (nodeId: string, queueId: string) =>
    chatDriver.removeQueued(nodeId, queueId))
  corePlatform.on(IPC.chatDispose, (nodeId: string) => chatDriver.dispose(nodeId))

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
      // Ensure fullscreen TUI in this account dir (write-if-absent, version-gated). Off the
      // critical path: it awaits the memoized CLI probe, then writes fail-open. (The system
      // ~/.claude is handled by installManagedAgentHooks above, which covers Server Edition too.)
      void ensureClaudeFullscreenTuiInto(claudeConfigDirFor(acct.id))
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
  // The jail (both allowed roots, incl. a managed remote account's) is pure + unit-tested in
  // claude-accounts-core.
  const safeRemoteTranscriptPath = (
    tp: string | undefined,
    remoteHome: string | undefined
  ): string | undefined => {
    if (!tp) return undefined
    const abs = posix.resolve(tp)
    return isSafeRemoteTranscriptPath(abs, remoteHome) ? abs : undefined
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

  // Releasing tails when a node's session ENDS — whichever way it ends. pty-manager handles the
  // same two channels to kill the tmux session; this extra listener tears down the per-node file
  // tailers so they stop polling a now-dead session:
  //  - pty:destroy — the user clicked × (the node is gone);
  //  - pty:recycle — "move into worktree" (the node stays, but its session is replaced, so the
  //    tails of the OLD session's transcript are just as dead; the respawned agent re-registers
  //    them under its new session id via the hook events).
  const releaseNodeTails = (nodeId: string): void => {
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
  }
  // A SECOND listener on these channels (PtyManager registers its own): both fire, in registration
  // order, on ipcMain AND in the platform's listener table — so a peer closing a node releases the
  // host's tails too, instead of leaking them.
  corePlatform.on(IPC.ptyDestroy, (nodeId: string) => releaseNodeTails(nodeId))
  corePlatform.on(IPC.ptyRecycle, (nodeId: string) => releaseNodeTails(nodeId))
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
  // Declared before initLicense so its onChange hook can re-reconcile the standing host once the
  // async launch-time entitlement refresh settles (fixes the boot race where Pro isn't yet valid
  // when syncFromSettings first runs).
  let standingHost: ReturnType<typeof initStandingHost> | undefined
  initLicense(() => standingHost?.syncFromSettings())
  // Lazy getter: sshProjectManager is created just below, so a remote account op (which only runs
  // after the user has connected an SSH project) always sees the live manager.
  initClaudeAccounts(() => sshProjectManager)
  initRemoteHost(win, ptyManager, listProjectsOutput)
  // NEW interactive relay host (Stage 4): a connecting peer desktop becomes a first-class
  // CorePlatform client of this desktop after mutual SAS approval. Runs BESIDE initRemoteHost (the
  // phone still uses the legacy flow). Inert until `relay:host:start` — a solo user pays nothing.
  // Revocation reaches its sessions via `killRelayHostsByPeerKey` (peerRevoker, above).
  initRelayHost(win, corePlatform, {})
  // Standing (phone) relay host: keep a host connection registered so a paired phone can reach
  // this Mac from anywhere. Honors settings.phoneAccessEnabled + the Pro gate internally.
  standingHost = initStandingHost(win, ptyManager, () => settingsStore.get(), listProjectsOutput)
  ipcMain.on(IPC.remoteStandingHostSet, (_e, enabled: boolean) => standingHost?.setEnabled(!!enabled))
  // Reconcile from persisted settings on launch (starts hosting if enabled + Pro).
  standingHost.syncFromSettings()
  initRemoteClient(win, { isPackaged: app.isPackaged })
  sshProjectManager = initSshProject(win, (projectId) => {
    // On (re)connect, reconcile the server's .nodeterm/project.json with our offline cache by rev.
    // A non-null result means the remote won → adopt it in the renderer (Task 7's listener does the
    // silent replace / conflict bar). null means our cache was pushed up instead — nothing to send.
    void workspaceStore.refreshSshProject(projectId).then((adopted) => {
      if (adopted) sendToMain(IPC.workspaceExternalChange, adopted)
    })
  })
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
  workspaceWatcher.dispose()
  sshProjectManager?.disconnectAll()
  chatDriver.disposeAll() // tear down every chat node's SDK query (resume-based, so this is safe)
  if (quitFlushed) return
  quitFlushed = true
  e.preventDefault()
  const flush = ptyManager.killAll()
  void Promise.race([flush, new Promise((r) => setTimeout(r, 1500))]).finally(() => app.quit())
})
