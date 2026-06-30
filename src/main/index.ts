import { join, resolve, sep, posix } from 'path'
import { homedir } from 'os'
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { IPC } from '../shared/ipc'
import * as fsOps from './fs-ops'
import { PtyManager } from './pty-manager'
import { WorkspaceStore } from './workspace-store'
import { SettingsStore } from './settings-store'
import { SshStore } from './ssh-store'
import { GitService } from './git-service'
import { generateCommitMessage, generateGroupName, generateTerminalName } from './commit-message'
import { initUpdater } from './updater'
import { fetchCheck } from './check'
import { hookServer } from './agents/hook-server'
import { installManagedAgentHooks } from './agents/hooks'
import { createSubagentTail } from './subagent-tail'
import { createContextTail } from './context-tail'
import {
  readTranscriptLines,
  readChatMessages,
  readSessionName,
  resolveTranscriptPath,
  transcriptPathForCwd,
  parseTranscriptLines,
  parseChatMessages,
  SESSION_ID_RE
} from './transcript-reader'
import { createRemoteContextTail } from './remote-context-tail'
import { createRemoteSubagentTail } from './remote-subagent-tail'
import { RemoteFile, type RemoteFileRef } from './remote-ssh/remote-file'
import { childArgs } from './remote-ssh/control-master'
import { posixQuote } from '../shared/ssh'
import { buildHandoff } from './handoff'
import { initContextLink, setNodeTranscript } from './context-link'
import { initTranscriptIndex, searchTranscripts } from './transcript-index'
import { initTelemetry } from './telemetry'
import { initClaudeUsage } from './claude-usage'
import { initLicense } from './license'
import { initRemoteHost } from './remote/host-service'
import { initRemoteClient } from './remote/client-service'
import { initSshProject } from './remote-ssh/ssh-project'
import { setGitRemoteResolver, type GitRemoteRef } from './remote-ssh/remote-git'
import { SshFs } from './ssh-fs'

// Dev-only: NT_MULTI lets a SECOND instance run (host + client testing on one machine) with an
// isolated userData via NT_USER_DATA — its own device-id/session/license/workspace. Never active
// in packaged builds. Must run before the stores below resolve userData paths.
const NT_MULTI = !app.isPackaged && !!process.env.NT_MULTI
if (NT_MULTI && process.env.NT_USER_DATA) app.setPath('userData', process.env.NT_USER_DATA)

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
// Set once the app window is ready; used by the quit hooks to tear down SSH-project masters.
let sshProjectManager: ReturnType<typeof initSshProject> | undefined

// Remote git routing is scoped to the ACTIVE project only (set via `git:set-active-remote`).
// A global cwd-keyed match would misroute when two SSH projects share a remote path, or when a
// LOCAL project's cwd equals a connected SSH project's remoteCwd. The renderer drives this on every
// project switch: the active SSH project's ref, or null for a local project (→ all git runs local).
let activeRemote: { cwd: string; ref: GitRemoteRef } | null = null

// The single app window — kept at module scope so IPC handlers (e.g. notifications)
// can check focus and route clicks back to the renderer.
let mainWin: BrowserWindow | null = null

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
    if (!mainWin) return
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.show()
    mainWin.focus()
  })
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
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

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

  ipcMain.handle(IPC.ptyReadSessionName, (_e, sessionId: string, cwd: string) =>
    readSessionName(sessionId ?? '', cwd ?? '')
  )

  ipcMain.on(IPC.appCloseWindow, () => BrowserWindow.getFocusedWindow()?.close())

  // Dock badge: number of Claude nodes with unread output (macOS only). '' clears it.
  ipcMain.on(IPC.appSetBadge, (_e, count: number) => {
    if (process.platform !== 'darwin' || !app.dock) return
    app.dock.setBadge(count > 0 ? String(count) : '')
  })

  // Show an OS notification — but only when the window is in the background. Clicking it
  // brings the app forward and asks the renderer to focus the originating node.
  ipcMain.handle(
    IPC.appNotify,
    (_e, payload: { title: string; body: string; nodeId: string; force?: boolean }) => {
      if (!mainWin || !Notification.isSupported()) return false
      // `force` (permission request / confirmation) shows even when focused; normal
      // completion notifications only show when the window is in the background.
      if (!payload.force && mainWin.isFocused()) return false
      const n = new Notification({ title: payload.title, body: payload.body })
      n.on('click', () => {
        if (!mainWin) return
        if (mainWin.isMinimized()) mainWin.restore()
        mainWin.show()
        mainWin.focus()
        if (payload.nodeId) mainWin.webContents.send(IPC.appFocusNode, payload.nodeId)
      })
      n.show()
      return true
    }
  )

  ipcMain.handle(IPC.announcementsFetch, async () => (await fetchCheck()).messages)
  ipcMain.handle(IPC.appUpdatePolicy, async () => (await fetchCheck()).update)

  // Writable base dir for app-managed files (e.g. default git worktree location).
  ipcMain.handle(IPC.appUserDataDir, () => app.getPath('userData'))

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
  mainWin = win
  initUpdater(win)

  // Agent hooks: install the managed hook script into each agent's config, then start the
  // local HTTP server that receives hook posts and forwards normalized events to the renderer.
  // A raw listener drives the transcript-tailing features (context meter + subagent transcript),
  // which need the raw transcript_path the NormalizedAgentEvent intentionally drops.
  const subagentTail = createSubagentTail(win)
  const contextTail = createContextTail(win)
  // Remote (SSH-project) counterparts: a node whose pty runs on a remote host has its Claude
  // transcript on that host, so its meter / subagent transcript / search must read over the
  // project's ControlMaster. One RemoteFile bound to the SSH-project manager's own ssh runner
  // (so reads reuse the live master); resolved lazily — sshProjectManager is created below but
  // these are only invoked once a remote hook POST arrives, long after init. Fail-open: a read
  // before the manager exists returns a non-zero code (RemoteFile maps that to empty).
  const remoteFile = new RemoteFile((args) =>
    sshProjectManager ? sshProjectManager.sshRun(args) : Promise.resolve({ code: 1, stdout: '' })
  )
  const remoteContextTail = createRemoteContextTail(win, remoteFile)
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
    cwd: string | undefined
  ): Promise<string | undefined> => {
    let p: string | undefined
    if (sessionId && SESSION_ID_RE.test(sessionId)) {
      p = contextTail.pathFor(sessionId) ?? (await resolveTranscriptPath(sessionId))
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
    async (_e, sessionId: string | undefined, cwd: string | undefined) => {
      const ref = sessionId ? remoteTranscriptBySession.get(sessionId) : undefined
      if (ref) {
        const text = await remoteFile.readTail(ref, REMOTE_TRANSCRIPT_CAP)
        return parseTranscriptLines(text)
      }
      const p = await resolveTranscript(sessionId, cwd)
      return p ? readTranscriptLines(p) : []
    }
  )

  ipcMain.handle(
    IPC.chatReadTranscript,
    async (_e, sessionId: string | undefined, cwd: string | undefined) => {
      const ref = sessionId ? remoteTranscriptBySession.get(sessionId) : undefined
      if (ref) {
        const text = await remoteFile.readTail(ref, REMOTE_TRANSCRIPT_CAP)
        return parseChatMessages(text.split('\n'))
      }
      const p = await resolveTranscript(sessionId, cwd)
      return p ? readChatMessages(p) : []
    }
  )

  initTranscriptIndex()
  ipcMain.handle(IPC.transcriptSearch, (_e, query: string) => searchTranscripts(query))
  // Populate the context meter without a live hook event: the renderer calls this on mount
  // (the continuing session may be idle after a restart). Track under the sessionId (the key
  // the meter looks up); cwd is only a path fallback. contextTail.track reads immediately and
  // the 1s interval keeps it fresh while tracked.
  ipcMain.on(IPC.contextEnsure, async (_e, sessionId?: string, cwd?: string) => {
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) return
    let p = contextTail.pathFor(sessionId) ?? (await resolveTranscriptPath(sessionId))
    if (!p && cwd) p = await transcriptPathForCwd(cwd)
    if (p) contextTail.track(sessionId, p)
  })
  ipcMain.handle(
    IPC.handoffBuild,
    (_e, sessionId: string, agentId: string, sourceNodeId: string, cwd: string | undefined) =>
      buildHandoff({ sessionId, agentId, sourceNodeId, cwd })
  )
  installManagedAgentHooks()
  hookServer.setListener((e) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.agentStatus, e)
  })
  // Security: hook POSTs now arrive over the remote reverse tunnel too (SSH Phase 2a), so a
  // forged/remote POST could set transcript_path to an arbitrary LOCAL path (e.g. ~/.ssh/id_rsa)
  // and have the app read it. The tails read the LOCAL filesystem; legitimate LOCAL transcripts
  // always live under ~/.claude/projects. Phase 2a does NOT tail remote transcripts (that's 2b),
  // so we jail transcript_path to that root and skip the read otherwise. Returns the path only
  // when it resolves under the projects root.
  const TRANSCRIPT_ROOT = join(homedir(), '.claude', 'projects')
  const safeTranscriptPath = (tp: string | undefined): string | undefined => {
    if (!tp) return undefined
    const abs = resolve(tp)
    return abs === TRANSCRIPT_ROOT || abs.startsWith(TRANSCRIPT_ROOT + sep) ? abs : undefined
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
    }
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
        } else if (p.hook_event_name === 'PostToolUse') {
          // Only cancel an in-flight resolve; if it already settled, adding here would leak.
          if (remoteSubagentResolving.has(toolUseId)) remoteSubagentCancel.add(toolUseId)
          remoteSubagentTail.untrack(toolUseId)
          if (nodeId) nodeSubagents.get(nodeId)?.delete(toolUseId)
        }
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
      } else if (p.hook_event_name === 'PostToolUse') {
        subagentTail.finish(p.tool_use_id)
        if (nodeId) nodeSubagents.get(nodeId)?.delete(p.tool_use_id)
      }
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
  await hookServer.start()

  initContextLink(win, ptyManager)
  initClaudeUsage(win)
  initTelemetry(() => settingsStore.get())
  initLicense(win)
  initRemoteHost(win, ptyManager)
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
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  ptyManager.killAll()
  sshProjectManager?.disconnectAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  ptyManager.killAll()
  sshProjectManager?.disconnectAll()
})
