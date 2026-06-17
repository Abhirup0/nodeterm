import type { PtyCreateOptions } from '@shared/types'

/**
 * Abstraction over the terminal session layer.
 *
 * The renderer/UI depends only on this interface; it does not know the concrete
 * implementation. The MVP has a single implementation, LocalTransport (IPC over
 * node-pty). A future RemoteTransport (a remote agent over WebSocket) implements
 * the same interface, so remote access can be added without changing the UI.
 */
export interface TerminalTransport {
  create(options: PtyCreateOptions): Promise<string>
  write(sessionId: string, data: string): void
  resize(sessionId: string, cols: number, rows: number): void
  /** Flow control: pause (false) / resume (true) the source when the terminal is backed up. */
  setFlow(sessionId: string, resume: boolean): void
  /** Detaches the client; with tmux the underlying session survives. */
  kill(sessionId: string): void
  /** Permanently ends a node's persistent session. */
  destroy(persistKey: string): void
  /** Listens for output; returns an unsubscribe function. */
  onData(sessionId: string, listener: (data: string) => void): () => void
  /** Fires when the session closes; returns an unsubscribe function. */
  onExit(sessionId: string, listener: (exitCode: number) => void): () => void
}
