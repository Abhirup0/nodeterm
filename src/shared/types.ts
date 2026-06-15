// Types shared across the main, preload, and renderer processes.

export interface PtyCreateOptions {
  shell?: string
  cwd?: string
  cols: number
  rows: number
}

/** Persisted state of a single terminal node. */
export interface TerminalNodeState {
  id: string
  position: { x: number; y: number }
  size: { width: number; height: number }
  title: string
  color: string
  group: string | null
  shell?: string
  cwd?: string
}

/** Canvas pan/zoom state. */
export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** The full workspace written to / read from disk. */
export interface Workspace {
  version: 1
  viewport: Viewport
  nodes: TerminalNodeState[]
}

export const EMPTY_WORKSPACE: Workspace = {
  version: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: []
}

// ---- Contract for the API exposed to the renderer via preload ----

export interface PtyApi {
  /** Starts a new PTY session, returns its sessionId. */
  create(options: PtyCreateOptions): Promise<string>
  /** Sends user input to the PTY. */
  write(sessionId: string, data: string): void
  /** Updates the PTY when the terminal is resized. */
  resize(sessionId: string, cols: number, rows: number): void
  /** Terminates the session. */
  kill(sessionId: string): void
  /** Listens for PTY output. Returns an unsubscribe function. */
  onData(sessionId: string, listener: (data: string) => void): () => void
  /** Fires when the PTY process exits. Returns an unsubscribe function. */
  onExit(sessionId: string, listener: (exitCode: number) => void): () => void
}

export interface WorkspaceApi {
  load(): Promise<Workspace>
  save(workspace: Workspace): Promise<void>
}

export interface NodeTerminalApi {
  pty: PtyApi
  workspace: WorkspaceApi
}
