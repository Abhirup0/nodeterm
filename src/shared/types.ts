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

export type NodeKind = 'terminal' | 'sticky' | 'group'

/** Persisted state of a single canvas node (terminal, sticky note, or group frame). */
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

export const EMPTY_WORKSPACE: Workspace = {
  version: 2,
  activeProjectId: DEFAULT_PROJECT_ID,
  projects: [
    {
      id: DEFAULT_PROJECT_ID,
      name: 'Project 1',
      color: '#7aa2f7',
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: []
    }
  ]
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
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 13,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  cursorBlink: true,
  defaultShell: '',
  gridSize: 24,
  snapToGrid: false,
  panHoverDelay: 300,
  doubleClickFocus: true,
  accent: '#0a84ff',
  tmuxEnabled: true,
  tmuxScrollback: 50000,
  commitAgent: 'claude',
  commitAgentCommand: '',
  commitExtraPrompt: ''
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
  /** Generate a commit message from the staged diff via a local AI agent CLI. */
  generateMessage(cwd: string): Promise<GitResult>
}

export interface NodeTerminalApi {
  pty: PtyApi
  workspace: WorkspaceApi
  dialog: DialogApi
  settings: SettingsApi
  git: GitApi
}
