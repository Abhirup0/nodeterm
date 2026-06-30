// Types shared across the main, preload, and renderer processes.

import type { NormalizedAgentEvent } from './agents/normalize'
import type { AgentId, PromptInjectionMode } from './agents/config'
import type { GroupWorktree } from './worktree'

export interface PtyCreateOptions {
  shell?: string
  /** Arguments for `shell` when it is run as the session program (e.g. ssh args). */
  shellArgs?: string[]
  cwd?: string
  cols: number
  rows: number
  /**
   * Stable key (the node id) used to derive a persistent tmux session name so the
   * terminal reattaches to the same session across remounts and app restarts.
   */
  persistKey?: string
  /**
   * Which agent runs in this session (claude/codex/gemini/custom). Drives the hook env
   * injected at spawn. Defaults to 'claude' for backward compat; the renderer passes a
   * real value in a later phase.
   */
  agentId?: AgentId
  /** When set, this PTY runs on a remote host over the project's ssh ControlMaster, in remote tmux. */
  sshRemote?: { controlPath: string; conn: import('./ssh').SshConnection; remoteCwd: string; hookEndpointPath?: string; tmuxConfPath?: string }
}

/**
 * Result of creating a PTY session. `fresh` distinguishes a tmux session that had to be
 * created anew (cold start — e.g. after a machine reboot killed the tmux server) from a
 * reattach to a still-running session (warm — e.g. an app restart). The renderer uses it to
 * replay the persisted scrollback and re-launch a resumable agent only on a cold start.
 */
export interface PtyCreateResult {
  sessionId: string
  fresh: boolean
}

// 'subagent' and 'loop' are render-only (ephemeral hook-driven viz) and never persisted.
export type NodeKind = 'terminal' | 'sticky' | 'group' | 'editor' | 'diff' | 'subagent' | 'loop' | 'dino'

/** Persisted state of a single canvas node (terminal, sticky note, group frame, or editor). */
export interface CanvasNodeState {
  id: string
  kind: NodeKind
  position: { x: number; y: number }
  size: { width: number; height: number }
  title: string
  /**
   * Agent nodes only: while true (the default), the node title auto-tracks the agent's own
   * session name. Set false once the user renames the node by hand, so we stop overwriting it
   * and instead push the user's name back to the agent via `/rename`. Persisted.
   */
  titleAuto?: boolean
  color: string
  group: string | null
  /** Labels for organizing/filtering terminals. */
  tags?: string[]
  /** When true the node body is hidden (header-only). */
  collapsed?: boolean
  /** Parent group node id, if this node belongs to a group frame. */
  parentId?: string
  // terminal-only
  shell?: string
  cwd?: string
  /** Which agent runs in this terminal node (claude/codex/gemini/custom). */
  agentId?: AgentId
  /** When set, the terminal runs `ssh` to this host on the local PTY; persisted (auto-reconnects). */
  ssh?: import('./ssh').SshConnection
  /** When true (SSH-project terminals), the node runs in REMOTE tmux on `ssh` rather than `ssh`-on-local-PTY. */
  sshRemoteTmux?: boolean
  /** editor-only: when true (SSH-project editors), reads/writes go to the project's remote fs via `sshFs`. */
  sshFs?: boolean
  // sticky-only
  text?: string
  // dino-only: best score reached in the T-Rex Runner game.
  highScore?: number
  // editor / diff
  filePath?: string
  /** diff-only: true = staged diff (HEAD vs index), false = unstaged (index vs working). */
  diffStaged?: boolean
  /** diff-only: when set, the diff shows parent (<oid>^) vs commit (<oid>) for a file from history. */
  commitOid?: string
  /** group-only: when bound, the git worktree this group works in. */
  worktree?: GroupWorktree
}

/**
 * A snapshot of one canvas's nodes in the form sent over the remote mirror wire.
 * Reuses the persisted node shape (`CanvasNodeState`) so host and client agree on layout.
 */
export interface CanvasState {
  nodes: CanvasNodeState[]
}

/**
 * A minimal change to a canvas node list: replace-or-append a node by id, or drop one by id.
 * Used for the client's optimistic edits and host-side diffing (see `applyMutation`/`diffToMutations`).
 */
export type CanvasMutation =
  | { op: 'upsert'; node: CanvasNodeState }
  | { op: 'remove'; id: string }

/** Canvas pan/zoom state. */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** A persistent "bridge" link between two Claude nodes (lets their sessions message each other). */
export interface BridgeLink {
  id: string
  source: string
  target: string
}

/** A project is one canvas/page: its own nodes, viewport, and default working dir. */
export interface Project {
  id: string
  name: string
  color: string
  /** Default working directory for new terminals created in this project. */
  cwd?: string
  /** When set, this is an SSH project: its terminals run on `server` in `remoteCwd` (remote tmux). */
  ssh?: { server: import('./ssh').SshConnection; remoteCwd: string }
  viewport: Viewport
  nodes: CanvasNodeState[]
  /** Bridge links between Claude nodes (optional; absent in pre-bridge files). */
  bridges?: BridgeLink[]
  /**
   * Closed projects are hidden from the tab bar but kept on disk with all their nodes (and their
   * tmux sessions left running) so they can be reopened from the start screen's "Recently closed"
   * list. Absent/false = an open tab. A closed project never becomes `activeProjectId`.
   */
  closed?: boolean
}

/** The full workspace written to / read from disk. */
export interface Workspace {
  version: 2
  activeProjectId: string
  projects: Project[]
}

/** Old single-canvas format (v1), kept only for migration on load. */
export interface WorkspaceV1 {
  version: 1
  viewport: Viewport
  nodes: CanvasNodeState[]
}

export const DEFAULT_PROJECT_ID = 'project-1'

// No projects on a fresh start → the renderer shows the welcome / start screen.
export const EMPTY_WORKSPACE: Workspace = {
  version: 2,
  activeProjectId: '',
  projects: []
}

// ---- Contract for the API exposed to the renderer via preload ----

export interface PtyApi {
  /** Starts a new PTY session; returns its sessionId and whether the session was freshly
   *  created (cold start) vs reattached to a still-running tmux session (warm). */
  create(options: PtyCreateOptions): Promise<PtyCreateResult>
  /** Sends user input to the PTY. */
  write(sessionId: string, data: string): void
  /** Updates the PTY when the terminal is resized. */
  resize(sessionId: string, cols: number, rows: number): void
  /** Flow control: pause (false) or resume (true) reading the PTY when xterm is backed up. */
  setFlow(sessionId: string, resume: boolean): void
  /** Detaches/terminates the PTY client (the underlying tmux session survives). */
  kill(sessionId: string): void
  /** Permanently ends the persistent session for a node (kills its tmux session). */
  destroy(persistKey: string): void
  /** Suggest a terminal title from its recent output via the configured AI agent. */
  generateName(persistKey: string, cwd: string): Promise<GitResult>
  /** Suggest a group title from its member terminals' recent output via the configured AI agent. */
  generateGroupName(memberKeys: string[], cwd: string): Promise<GitResult>
  /** Capture a terminal session's output as text. `full` grabs the entire scrollback. */
  capture(persistKey: string, full?: boolean): Promise<string>
  /** Read the persisted scrollback snapshot for a node (for cold-restart replay). '' if none. */
  readScrollback(persistKey: string): Promise<string>
  /** Send literal text + Enter into a session (e.g. a slash command). Returns false if unavailable. */
  sendText(persistKey: string, text: string): Promise<boolean>
  /** The agent session's display name (`/rename` name, else auto name) read from its transcript;
   *  null if none. Used to keep a node title in sync with the `/resume` name (e.g. after resume). */
  readSessionName(sessionId: string, cwd: string): Promise<string | null>
  /** Listens for PTY output. Returns an unsubscribe function. */
  onData(sessionId: string, listener: (data: string) => void): () => void
  /** Fires when the PTY process exits. Returns an unsubscribe function. */
  onExit(sessionId: string, listener: (exitCode: number) => void): () => void
}

export interface WorkspaceApi {
  load(): Promise<Workspace>
  save(workspace: Workspace): Promise<void>
}

export interface DialogApi {
  /** Opens a native folder picker; returns the chosen path or null if cancelled. */
  selectFolder(): Promise<string | null>
  /** Opens a native file picker; returns the chosen path or null if cancelled. */
  selectFile(): Promise<string | null>
}

export interface ClipboardApi {
  writeText(text: string): void
}

export interface ShellApi {
  /** Reveal a path in the OS file manager (Finder). */
  reveal(path: string): void
  /** Open a path with the OS default application. */
  openPath(path: string): void
  /** Open an http(s) URL in the OS default browser. */
  openExternal(url: string): void
}

export interface DirEntry {
  name: string
  dir: boolean
  /** True when the entry is matched by .gitignore (shown dimmed). */
  ignored?: boolean
}

export interface FsApi {
  /** List a directory (folders first, then files; alphabetical). */
  list(dirPath: string): Promise<DirEntry[]>
  /** Read a file's text contents (empty string on error). */
  read(filePath: string): Promise<string>
  /** Read a file as base64 (for images and other binary previews; '' on error). */
  readBinary(filePath: string): Promise<string>
  /** Write text to a file; resolves true on success. */
  write(filePath: string, content: string): Promise<boolean>
}

export interface FilesApi {
  /** Fuzzy-open file index for a project root: root-relative `/`-paths ([] on failure). */
  quickOpen(cwd: string): Promise<string[]>
}

/** A user-defined agent (BYO CLI). In no capability list, so it gets only spawn +
 * terminal-title + process status (no hooks/branch/loop/bridge). */
export interface CustomAgent {
  /** Stable id of the form 'custom:<uuid>'. Used as the node's agentId. */
  id: string
  label: string
  launchCmd: string
  promptInjectionMode: PromptInjectionMode
}

/** User-configurable application settings (settings.json). */
export interface Settings {
  fontSize: number
  fontFamily: string
  cursorBlink: boolean
  /** Empty string = use the system default shell. */
  defaultShell: string
  gridSize: number
  snapToGrid: boolean
  /** ms to dwell over a terminal before it takes pointer focus (pan-across guard). */
  panHoverDelay: number
  doubleClickFocus: boolean
  accent: string
  tmuxEnabled: boolean
  tmuxScrollback: number
  /** AI commit message agent: a local coding-agent CLI run read-only. */
  commitAgent: 'claude' | 'codex' | 'custom'
  /** For commitAgent='custom': command template; {prompt} placeholder optional (else stdin). */
  commitAgentCommand: string
  /** Extra instructions appended to the commit prompt (e.g. Conventional Commits). */
  commitExtraPrompt: string
  /** Whether the shortcuts overlay has been shown on first launch. */
  seenShortcuts: boolean
  /** Notify (OS notification) when a Claude Code turn finishes while the app is in the background. */
  notifyOnClaudeDone: boolean
  /** Periodically `git fetch` while the Source Control panel is open, so ahead/behind stays
   *  accurate (remote/SSH projects fetch on the remote). */
  gitAutoFetch: boolean
  /** Whether the one-time notification consent prompt has been shown. */
  notifyConsentAsked: boolean
  /** User-defined agents (BYO CLI) appended to the Add menus. */
  customAgents: CustomAgent[]
  /** Agent ids hidden from the Add menus. */
  disabledAgents: AgentId[]
  /** Which agent the ⌘⇧C shortcut / quick-add launches. Always a launchable builtin. */
  defaultAgent: AgentId
  /** Send anonymous usage data (version/OS) to the telemetry backend. Opt-in (default off)
   *  so we never collect without explicit consent (GDPR). Toggle in Settings → Privacy. */
  telemetryEnabled: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 13,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  cursorBlink: true,
  defaultShell: '',
  gridSize: 24,
  snapToGrid: false,
  panHoverDelay: 600,
  doubleClickFocus: true,
  accent: '#0a84ff',
  tmuxEnabled: true,
  tmuxScrollback: 50000,
  commitAgent: 'claude',
  commitAgentCommand: '',
  commitExtraPrompt: '',
  seenShortcuts: false,
  notifyOnClaudeDone: true,
  gitAutoFetch: true,
  notifyConsentAsked: false,
  customAgents: [],
  disabledAgents: [],
  defaultAgent: 'claude',
  telemetryEnabled: false
}

export interface SettingsApi {
  load(): Promise<Settings>
  save(settings: Settings): Promise<void>
}

export interface SshApi {
  list(): Promise<import('./ssh').SshServer[]>
  save(server: import('./ssh').SshServer): Promise<import('./ssh').SshServer[]>
  remove(id: string): Promise<import('./ssh').SshServer[]>
  /** Parse `~/.ssh/config` into importable hosts (empty if none). */
  importCandidates(): Promise<import('./ssh').ParsedSshHost[]>
}

export type SshProjectStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error'

export interface SshProjectApi {
  /** Open (or reuse) the ControlMaster for an SSH project; resolves once connected. */
  connect(
    projectId: string,
    server: import('./ssh').SshConnection,
    remoteCwd?: string
  ): Promise<{ controlPath: string; hookEndpointPath?: string; tmuxConfPath?: string }>
  /** Tear down the master (remote tmux is unaffected). */
  disconnect(projectId: string): Promise<void>
  /**
   * End the given terminal nodes' REMOTE tmux sessions over the project's live master.
   * Authoritative teardown on project delete: works regardless of whether the nodes are
   * mounted, and must be awaited BEFORE disconnect (which kills the master). `nodeIds` are
   * raw node ids; main maps them to `nt-<id>` session names.
   */
  killSessions(projectId: string, nodeIds: string[]): Promise<void>
  /** List remote sub-directories of `path` (default ~). */
  listDir(projectId: string, path: string): Promise<{ path: string; dirs: string[] }>
  /** Create a remote directory (mkdir -p). Resolves false when not connected or the mkdir fails. */
  mkdir(projectId: string, path: string): Promise<boolean>
  /**
   * Upload a local file to the remote over the project's ControlMaster, into
   * `<remoteHome>/.nodeterm/uploads/<token>/<fileName>`. Resolves the ABSOLUTE remote path on
   * success, or null on any failure (not connected, unresolved remote home, mkdir/scp failure).
   */
  uploadFile(projectId: string, localPath: string, fileName: string): Promise<string | null>
  onStatus(cb: (e: { projectId: string; status: SshProjectStatus; error?: string }) => void): () => void
}

/**
 * SSH-project Explorer/Editor filesystem API: the same `FsApi` contract scoped to a project,
 * proxied over the project's ControlMaster (renderer → `sshFs:*` IPC → main `SshFs`). The renderer
 * `sshFs(projectId)` helper closes over `projectId` to expose a plain `FsApi`. Mirrors
 * `RemoteClientApi.fs*` for relay connections; fails open ([]/''/false) when the project is not
 * connected.
 */
export interface SshFsApi {
  list(projectId: string, path: string): Promise<DirEntry[]>
  read(projectId: string, path: string): Promise<string>
  readBinary(projectId: string, path: string): Promise<string>
  write(projectId: string, path: string, content: string): Promise<boolean>
}

export interface GitFileChange {
  path: string
  /** Single-letter status: M (modified), A (added), D (deleted), R (renamed), U (untracked). */
  status: string
  added: number
  deleted: number
}

export interface GitStatus {
  hasRepo: boolean
  /** "owner/repo" from the origin remote, else the folder name. */
  repoName: string
  branch: string
  /** Local branch names (for the branch switcher). */
  branches: string[]
  ahead: number
  behind: number
  /** The repo has at least one remote (origin). */
  hasRemote: boolean
  /** The current branch has an upstream tracking ref (i.e. it has been published). */
  hasUpstream: boolean
  ghAvailable: boolean
  ghAuthed: boolean
  staged: GitFileChange[]
  changes: GitFileChange[]
}

export interface GitResult {
  ok: boolean
  message: string
  /** Set by publish() when no usable GitHub credential was found, so the UI can
   *  fall back to an interactive `gh auth login` instead of just showing an error. */
  needsAuth?: boolean
}

export interface GitApi {
  status(cwd: string): Promise<GitStatus>
  init(cwd: string): Promise<GitResult>
  /** Clone a repo into parentDir; returns the cloned folder path in message on success. */
  clone(parentDir: string, url: string): Promise<GitResult>
  /** Commits the staged changes (no implicit add). */
  commit(cwd: string, message: string): Promise<GitResult>
  push(cwd: string): Promise<GitResult>
  pull(cwd: string): Promise<GitResult>
  /** Pull then push. */
  sync(cwd: string): Promise<GitResult>
  publish(cwd: string, name: string, isPrivate: boolean): Promise<GitResult>
  stage(cwd: string, paths: string[]): Promise<GitResult>
  unstage(cwd: string, paths: string[]): Promise<GitResult>
  stageAll(cwd: string): Promise<GitResult>
  unstageAll(cwd: string): Promise<GitResult>
  /** Unified diff for a file. `staged` selects index vs worktree; untracked shows full file. */
  diff(cwd: string, path: string, staged: boolean, untracked: boolean): Promise<string>
  /** Discard a file's changes (or delete it if untracked). */
  discard(cwd: string, path: string, untracked: boolean): Promise<GitResult>
  switchBranch(cwd: string, name: string): Promise<GitResult>
  createBranch(cwd: string, name: string): Promise<GitResult>
  /** File contents at a git ref ('HEAD', or '' for the index/staged blob). */
  showFile(cwd: string, ref: string, path: string): Promise<string>
  /** Generate a commit message from the staged diff via a local AI agent CLI. */
  generateMessage(cwd: string): Promise<GitResult>
  /** Commit history graph for the repo. */
  history(
    cwd: string,
    options?: { limit?: number; baseRef?: string | null }
  ): Promise<import('./git-history').GitHistoryResult>
  /** File-level changes introduced by a commit (oid). */
  commitFiles(cwd: string, oid: string): Promise<GitFileChange[]>
  /** Remote web URL for a commit sha, or null if it can't be derived. */
  remoteCommitUrl(cwd: string, sha: string): Promise<string | null>
  /** Merge a branch into the current branch. */
  merge(cwd: string, ref: string): Promise<GitResult>
  /** Rebase the current branch onto another. */
  rebase(cwd: string, onto: string): Promise<GitResult>
  /** Delete a branch (force = -D, for unmerged). */
  deleteBranch(cwd: string, name: string, force: boolean): Promise<GitResult>
  /** Rename the current branch. */
  renameBranch(cwd: string, newName: string): Promise<GitResult>
  /** Fetch all remotes and prune. */
  fetch(cwd: string): Promise<GitResult>
  /** Push with --force-with-lease. */
  forcePush(cwd: string): Promise<GitResult>
  /** Stash uncommitted changes (incl. untracked). */
  stashPush(cwd: string): Promise<GitResult>
  /** Pop the latest stash. */
  stashPop(cwd: string): Promise<GitResult>
  /** Revert a commit (--no-edit). */
  revert(cwd: string, oid: string): Promise<GitResult>
  /** Create + switch to a new branch at a commit. */
  branchAt(cwd: string, name: string, oid: string): Promise<GitResult>
  /** Checkout a commit (detached HEAD). */
  checkoutCommit(cwd: string, oid: string): Promise<GitResult>
  repoRoot(cwd: string): Promise<string | null>
  worktreeList(repoPath: string): Promise<import('./worktree').WorktreeEntry[]>
  worktreeAdd(repoPath: string, wtPath: string, branch: string, baseRef: string, isNew: boolean): Promise<GitResult>
  worktreeMerge(repoPath: string, branch: string, baseRef: string): Promise<GitResult>
  worktreeRemove(repoPath: string, wtPath: string, deleteBranch: boolean): Promise<GitResult>
  /** Scope remote git routing to the active project: pass its id to route git over that SSH
   *  project's master, or null for a local project so all git ops run locally. */
  setActiveRemote(projectId: string | null): Promise<void>
}

export interface UpdateInfo {
  version: string
  notes?: string
}

export interface UpdatePolicy {
  /** Minimum supported version for the device's channel (or null when no policy). */
  minSupported: string | null
  /** True when the running version is below the minimum supported version. */
  mandatory: boolean
}

export interface UpdateProgress {
  /** 0–100. */
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateApi {
  /** A newer version was found and is downloading. Returns unsubscribe. */
  onAvailable(listener: (info: UpdateInfo) => void): () => void
  /** The update finished downloading and is ready to install. Returns unsubscribe. */
  onDownloaded(listener: (info: UpdateInfo) => void): () => void
  /** Download progress ticks while an update downloads. Returns unsubscribe. */
  onProgress(listener: (p: UpdateProgress) => void): () => void
  /** An updater error occurred (drives the card's error state). Returns unsubscribe. */
  onError(listener: (message: string) => void): () => void
  /** No newer version is available (also the dev no-op reply to check()). Returns unsubscribe. */
  onNotAvailable(listener: () => void): () => void
  /** Trigger a manual update check. */
  check(): void
  /** The running app version. */
  getVersion(): Promise<string>
  /** The channel's mandatory-update policy for the running version (from /v1/check). */
  getPolicy(): Promise<UpdatePolicy>
  /** Quit and install the staged update. */
  restart(): void
}

/** A single news/announcement item, fetched from the remote announcements feed. */
export interface Announcement {
  /** Stable unique id; used to remember which items the user has dismissed. */
  id: string
  title: string
  body?: string
  /** Optional "Learn more" link (opened in the system browser). */
  url?: string
  /** Visual emphasis; defaults to 'info'. */
  level?: 'info' | 'success' | 'warning'
}

export interface AnnouncementsApi {
  /** Fetch the announcements feed from the website (returns [] on any failure). */
  fetch(): Promise<Announcement[]>
}

export interface NotifyPayload {
  title: string
  body: string
  /** Node to focus/center when the notification is clicked. */
  nodeId: string
  /** Show even when the window is focused (used to trigger the macOS permission prompt). */
  force?: boolean
}

/** A chunk of a subagent's live transcript, streamed while it works. */
export interface SubagentActivity {
  toolUseId: string
  chunk: string
}

/** One linked node, as the context-link CLI sees it. */
export interface ContextLinkInfo {
  id: string
  title: string
  /** The linked node's working dir — lets the CLI resolve a transcript when the path isn't known yet. */
  cwd?: string
}

/** Map of node id → the nodes it is context-linked to. Sent to main so it can write link files. */
export type ContextLinkMap = Record<string, ContextLinkInfo[]>

export interface ContextLinkApi {
  /** Push the current link map to main; main rewrites the per-node link files. */
  setLinks(map: ContextLinkMap): Promise<void>
}

/** One usage window (5h session or 7d weekly) as shown in the indicator. */
export interface ClaudeUsageWindow {
  /** 0–100; remaining quota. Drives the bar fill (shows "remaining"). */
  leftPercent: number
  /** Unix ms when this window resets, or null if unknown. */
  resetsAt: number | null
}

/** Claude Code subscription usage snapshot for the bottom-left indicator. */
export interface ClaudeUsage {
  session: ClaudeUsageWindow | null
  weekly: ClaudeUsageWindow | null
  /** Signed-in account email, read-only and best-effort (null if unknown). */
  email: string | null
  /** Unix ms when this snapshot was produced. */
  updatedAt: number
  /**
   * 'unavailable' = no OAuth subscription token (API-key billing / logged out) → hide pill.
   * 'fetching' = request in flight. 'ok' = windows present. 'error' = fetch failed.
   */
  status: 'unavailable' | 'fetching' | 'ok' | 'error'
}

export interface UsageApi {
  /** Returns the latest snapshot (cached if fresh, else a fresh fetch). */
  fetch(): Promise<ClaudeUsage>
  /** Forces a fresh fetch, bypassing the focus debounce. */
  refresh(): Promise<ClaudeUsage>
  /** Fires whenever main pushes a new snapshot (poll/refresh). Returns unsubscribe. */
  onUpdate(listener: (usage: ClaudeUsage) => void): () => void
}

/** A Claude session's context-window fill, pushed per sessionId from the transcript tailer. */
export interface ContextWindowUsage {
  sessionId: string
  /** input + cache_read + cache_creation tokens of the latest assistant message. */
  usedTokens: number
  /** Model context window (200k default, 1M for 1m-context models). */
  windowTokens: number
  /** 0–100 fullness. */
  usedPercent: number
  /** Model id from the transcript, or null if not seen yet. */
  model: string | null
  updatedAt: number
}

export interface ContextApi {
  /** Fires whenever a session's context fill changes. Returns unsubscribe. */
  onUpdate(listener: (usage: ContextWindowUsage) => void): () => void
  /**
   * Ask main to start (or refresh) tracking a session's transcript so the meter populates
   * without waiting for a live hook event — e.g. on node mount after an app restart, when
   * the continuing session is idle. `cwd` is a transcript-path fallback only.
   */
  ensure(sessionId: string, cwd?: string): void
}

/** One searchable line extracted from a Claude session transcript. */
export interface TranscriptLine {
  role: 'user' | 'assistant' | 'tool'
  text: string
}

/** One ordered piece of a chat message: prose, or a tool call with an optional result. */
export type ChatPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; arg: string; result?: string }

/** A structured chat message reconstructed from a Claude session transcript. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  parts: ChatPart[]
}

export interface ChatApi {
  /**
   * Reads a Claude session transcript as structured chat messages ([] if unavailable).
   * Resolves the transcript like `ClaudeApi.readTranscript` (sessionId → cwd), then
   * reconstructs ordered bubbles + tool calls.
   */
  readTranscript(
    sessionId: string | undefined,
    cwd: string | undefined
  ): Promise<ChatMessage[]>
}

/** One ranked search hit across all on-disk Claude session transcripts. */
export interface TranscriptHit {
  sessionId: string
  title: string
  snippet: string
  cwd: string
  projectLabel: string
  mtime: number
}

export interface TranscriptsApi {
  /** Search all on-disk Claude session transcripts by content. */
  search(query: string): Promise<TranscriptHit[]>
}

export interface ClaudeApi {
  /**
   * Reads a Claude session's full transcript as flat searchable lines ([] if unavailable).
   * Resolves by `sessionId` when known (exact); otherwise falls back to `cwd` (durable —
   * the newest transcript under that project dir, no live hook event required).
   */
  readTranscript(
    sessionId: string | undefined,
    cwd: string | undefined
  ): Promise<TranscriptLine[]>
}

export type HandoffResult = { filePath: string } | { error: string }

export interface HandoffApi {
  /**
   * Render the source agent's full conversation transcript (located by `sessionId`)
   * to a portable Markdown file under `<cwd>/.nodeterm/` and return its absolute path.
   * No summarization — the entire transcript including tool calls and outputs.
   */
  build(
    sessionId: string,
    agentId: string,
    sourceNodeId: string,
    cwd: string | undefined
  ): Promise<HandoffResult>
}

export interface LicenseStatus {
  /** 'pro' when entitled, else null. */
  tier: string | null
  active: boolean
  /** Unix seconds when the entitlement expires, or null. */
  expiresAt: number | null
  /** Last activation/refresh error reason code, or null. */
  error: string | null
}

export interface LicenseApi {
  /** Open Stripe checkout bound to this device and poll for the entitlement (no key paste).
   * Returns the current status immediately; the active status arrives via onChange. */
  upgrade(): Promise<LicenseStatus>
  /** Activate a license key on this device. Returns the resulting status. */
  activate(key: string): Promise<LicenseStatus>
  /** Release this device's seat and clear the local license. */
  deactivate(): Promise<LicenseStatus>
  /** Current cached status (verifies the stored token offline). */
  getStatus(): Promise<LicenseStatus>
  /** Fires when the license status changes. Returns unsubscribe. */
  onChange(listener: (s: LicenseStatus) => void): () => void
}

export interface RemoteHostApi {
  /**
   * Enter host mode: mint a pairing token, connect to the relay as the host, and return the
   * pairing offer string (`nodeterm://pair?code=…`) to hand to a client. Rejects if the device
   * is not entitled to Pro (or in a dev build without NODETERM_RELAY_URL).
   */
  start(): Promise<{ offer: string }>
  /** Leave host mode: close the relay connection (ends served PTYs, drops client access). */
  stop(): Promise<void>
  /**
   * Push the host's current active-project canvas snapshot to main. Main keeps the latest
   * and (re)broadcasts it to a connected client (debounced). Safe to call when not hosting.
   */
  sendCanvasState(state: CanvasState): void
  /**
   * Listen for a client's mutation command that the host renderer must apply to its React
   * Flow (the single writer). Returns an unsubscribe function.
   */
  onApplyMutation(listener: (mutation: CanvasMutation) => void): () => void
  /**
   * Fires when a client finishes the E2EE handshake and is awaiting approval. The host must call
   * `approve()` before any of the client's pty/fs RPCs are served; `sas` is the channel
   * verification code to display. Returns an unsubscribe function.
   */
  onPeerPending(listener: (info: { sas: string | null }) => void): () => void
  /** Approve the pending client → the host begins serving its pty/fs RPCs. */
  approve(): void
  /** Reject the pending client → the connection is dropped. */
  reject(): void
}

export interface RemoteClientApi {
  /**
   * Connect to a host by its pairing offer string (`nodeterm://pair?code=…` or a bare code).
   * Gates on a valid Pro entitlement (rejects otherwise, and in dev builds without
   * NODETERM_RELAY_URL). Resolves with a `connectionId` to address with the methods below.
   */
  connect(offer: string): Promise<string>
  /** Close a connection: ends the relay socket and drops access to the host's PTYs. */
  disconnect(connectionId: string): Promise<void>
  /** Open a remote PTY on the connected host; resolves with its session id. */
  create(connectionId: string, options: PtyCreateOptions): Promise<string>
  /** Send input to a remote PTY. */
  write(connectionId: string, sessionId: string, data: string): void
  /** Resize a remote PTY. */
  resize(connectionId: string, sessionId: string, cols: number, rows: number): void
  /** Kill a remote PTY (the host detaches; its tmux session survives host-side). */
  kill(connectionId: string, sessionId: string): void
  /** Listen for a remote PTY's output. Returns an unsubscribe function. */
  onData(connectionId: string, sessionId: string, listener: (data: string) => void): () => void
  /** Fires when a remote PTY exits. Returns an unsubscribe function. */
  onExit(
    connectionId: string,
    sessionId: string,
    listener: (exitCode: number) => void
  ): () => void
  /** Fires when the connection's relay socket drops (host/relay gone). Returns unsubscribe. */
  onClosed(connectionId: string, listener: () => void): () => void
  /**
   * Listen for the host's full canvas snapshot for a connection (the mirror source of truth).
   * Returns an unsubscribe function.
   */
  onCanvasState(connectionId: string, listener: (state: CanvasState) => void): () => void
  /**
   * Listen for the channel SAS once the handshake completes, so the client human can compare it
   * with the code shown on the host before the host approves. Returns an unsubscribe function.
   */
  onSas(connectionId: string, listener: (sas: string | null) => void): () => void
  /**
   * Send a canvas mutation to the host (the client's optimistic edit). Main forwards it as a
   * `canvas:mutate` RPC; the host applies it and the next `canvas:state` reconciles.
   */
  sendMutation(connectionId: string, mutation: CanvasMutation): void
  /** List a directory on the host's filesystem (the `FsApi.list` shape over the relay). */
  fsList(connectionId: string, path: string): Promise<DirEntry[]>
  /** Read a host file's UTF-8 text (the `FsApi.read` shape over the relay). */
  fsRead(connectionId: string, path: string): Promise<string>
  /** Read a host file as base64 (the `FsApi.readBinary` shape over the relay). */
  fsReadBinary(connectionId: string, path: string): Promise<string>
  /** Write UTF-8 text to a host file (the `FsApi.write` shape over the relay). */
  fsWrite(connectionId: string, path: string, content: string): Promise<boolean>
}

export interface NodeTerminalApi {
  pty: PtyApi
  workspace: WorkspaceApi
  dialog: DialogApi
  settings: SettingsApi
  ssh: SshApi
  sshProject: SshProjectApi
  sshFs: SshFsApi
  git: GitApi
  clipboard: ClipboardApi
  shell: ShellApi
  fs: FsApi
  files: FilesApi
  updates: UpdateApi
  announcements: AnnouncementsApi
  license: LicenseApi
  contextLink: ContextLinkApi
  usage: UsageApi
  context: ContextApi
  claude: ClaudeApi
  chat: ChatApi
  transcripts: TranscriptsApi
  remoteHost: RemoteHostApi
  remoteClient: RemoteClientApi
  handoff: HandoffApi
  /** Fires when the user presses Cmd/Ctrl+M (toggle markdown view). Returns unsubscribe. */
  onMarkdownToggle(listener: () => void): () => void
  /** Fires when the user presses Cmd/Ctrl+W (close selected node). Returns unsubscribe. */
  onCloseNode(listener: () => void): () => void
  /** Close the application window (Cmd/Ctrl+W fallback when no node is selected). */
  closeWindow(): void
  /** Set the macOS Dock badge to the unread-message count (0 clears it). */
  setBadgeCount(count: number): void
  /** Absolute filesystem path for a dropped/picked File (for drag-into-terminal). */
  getPathForFile(file: File): string
  /** Absolute writable base dir (Electron userData) for app-managed files like default worktrees. */
  userDataDir(): Promise<string>
  /** Show an OS notification (main suppresses it if the window is focused). Returns whether shown. */
  notify(payload: NotifyPayload): Promise<boolean>
  /** Fires when a notification is clicked, asking the renderer to focus a node. Returns unsubscribe. */
  onFocusNode(listener: (nodeId: string) => void): () => void
  /** Fires on each normalized agent hook event (working/done/waiting/subagent/…). Returns unsubscribe. */
  onAgentStatus(listener: (e: NormalizedAgentEvent) => void): () => void
  /** Fires with live subagent transcript chunks while a subagent runs. Returns unsubscribe. */
  onSubagentActivity(listener: (e: SubagentActivity) => void): () => void
}
