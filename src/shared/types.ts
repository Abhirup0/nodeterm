// Types shared across the main, preload, and renderer processes.

export interface PtyCreateOptions {
  shell?: string
  cwd?: string
  cols: number
  rows: number
  /**
   * Stable key (the node id) used to derive a persistent tmux session name so the
   * terminal reattaches to the same session across remounts and app restarts.
   */
  persistKey?: string
}

// 'subagent' and 'loop' are render-only (ephemeral hook-driven viz) and never persisted.
export type NodeKind = 'terminal' | 'sticky' | 'group' | 'editor' | 'diff' | 'subagent' | 'loop'

/** Persisted state of a single canvas node (terminal, sticky note, group frame, or editor). */
export interface CanvasNodeState {
  id: string
  kind: NodeKind
  position: { x: number; y: number }
  size: { width: number; height: number }
  title: string
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
  // sticky-only
  text?: string
  // editor / diff
  filePath?: string
  /** diff-only: true = staged diff (HEAD vs index), false = unstaged (index vs working). */
  diffStaged?: boolean
}

/** Canvas pan/zoom state. */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** A project is one canvas/page: its own nodes, viewport, and default working dir. */
export interface Project {
  id: string
  name: string
  color: string
  /** Default working directory for new terminals created in this project. */
  cwd?: string
  viewport: Viewport
  nodes: CanvasNodeState[]
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
  /** Starts a new PTY session, returns its sessionId. */
  create(options: PtyCreateOptions): Promise<string>
  /** Sends user input to the PTY. */
  write(sessionId: string, data: string): void
  /** Updates the PTY when the terminal is resized. */
  resize(sessionId: string, cols: number, rows: number): void
  /** Detaches/terminates the PTY client (the underlying tmux session survives). */
  kill(sessionId: string): void
  /** Permanently ends the persistent session for a node (kills its tmux session). */
  destroy(persistKey: string): void
  /** Suggest a terminal title from its recent output via the configured AI agent. */
  generateName(persistKey: string, cwd: string): Promise<GitResult>
  /** Capture a terminal session's output as text. `full` grabs the entire scrollback. */
  capture(persistKey: string, full?: boolean): Promise<string>
  /** Send literal text + Enter into a session (e.g. a slash command). Returns false if unavailable. */
  sendText(persistKey: string, text: string): Promise<boolean>
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
  /** Whether the one-time notification consent prompt has been shown. */
  notifyConsentAsked: boolean
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
  notifyConsentAsked: false
}

export interface SettingsApi {
  load(): Promise<Settings>
  save(settings: Settings): Promise<void>
}

export interface GitFileChange {
  path: string
  /** Single-letter status: M (modified), A (added), D (deleted), R (renamed), U (untracked). */
  status: string
  added: number
  deleted: number
}

export interface GitCommit {
  hash: string
  subject: string
  relative: string
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
  hasRemote: boolean
  ghAvailable: boolean
  ghAuthed: boolean
  staged: GitFileChange[]
  changes: GitFileChange[]
  recent: GitCommit[]
}

export interface GitResult {
  ok: boolean
  message: string
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
}

export interface UpdateInfo {
  version: string
  notes?: string
}

export interface UpdateApi {
  /** A newer version was found and is downloading. Returns unsubscribe. */
  onAvailable(listener: (info: UpdateInfo) => void): () => void
  /** The update finished downloading and is ready to install. Returns unsubscribe. */
  onDownloaded(listener: (info: UpdateInfo) => void): () => void
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

/** A Claude Code lifecycle hook event, forwarded from the main process. */
export interface ClaudeStatusEvent {
  nodeId: string
  /** SessionStart | UserPromptSubmit | Stop | Notification | SessionEnd | PreToolUse | PostToolUse */
  event: string
  sessionId?: string
  /** For Notification events: e.g. 'permission_prompt' | 'idle_prompt'. */
  notificationType?: string
  /** Claude's last assistant message (on Stop) — used as the notification body. */
  lastMessage?: string
  /** The user's prompt (UserPromptSubmit) — used to detect `/loop`. */
  prompt?: string
  /** Subagent tool events (PreToolUse/PostToolUse, tool_name Agent/Task). */
  toolName?: string
  toolUseId?: string
  subagentType?: string
  taskLabel?: string
  /** Recurring-task tools: skill name (Skill) and cron expression (CronCreate). */
  skill?: string
  schedule?: string
  /** Subagent result metadata (PostToolUse tool_response). */
  status?: string
  durationMs?: number
  tokens?: number
  toolUses?: number
  /** The subagent's result text (what it produced). */
  result?: string
}

/** A chunk of a subagent's live transcript, streamed while it works. */
export interface SubagentActivity {
  toolUseId: string
  chunk: string
}

export interface NodeTerminalApi {
  pty: PtyApi
  workspace: WorkspaceApi
  dialog: DialogApi
  settings: SettingsApi
  git: GitApi
  clipboard: ClipboardApi
  shell: ShellApi
  fs: FsApi
  updates: UpdateApi
  announcements: AnnouncementsApi
  /** Fires when the user presses Cmd/Ctrl+M (toggle markdown view). Returns unsubscribe. */
  onMarkdownToggle(listener: () => void): () => void
  /** Fires when the user presses Cmd/Ctrl+W (close selected node). Returns unsubscribe. */
  onCloseNode(listener: () => void): () => void
  /** Close the application window (Cmd/Ctrl+W fallback when no node is selected). */
  closeWindow(): void
  /** Show an OS notification (main suppresses it if the window is focused). Returns whether shown. */
  notify(payload: NotifyPayload): Promise<boolean>
  /** Fires when a notification is clicked, asking the renderer to focus a node. Returns unsubscribe. */
  onFocusNode(listener: (nodeId: string) => void): () => void
  /** Fires on each Claude Code hook event (start/working/idle/attention). Returns unsubscribe. */
  onClaudeStatus(listener: (e: ClaudeStatusEvent) => void): () => void
  /** Fires with live subagent transcript chunks while a subagent runs. Returns unsubscribe. */
  onSubagentActivity(listener: (e: SubagentActivity) => void): () => void
}
