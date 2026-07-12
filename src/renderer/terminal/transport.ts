import type { PtyCreateOptions, PtyCreateResult } from '@shared/types'
import type { ClientId } from '@shared/presence'

/**
 * Abstraction over the terminal session layer.
 *
 * The renderer/UI depends only on this interface; it does not know the concrete
 * implementation. The MVP has a single implementation, LocalTransport (IPC over
 * node-pty). A future RemoteTransport (a remote agent over WebSocket) implements
 * the same interface, so remote access can be added without changing the UI.
 */
export interface TerminalTransport {
  create(options: PtyCreateOptions): Promise<PtyCreateResult>
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
  /**
   * The authoritative size of a co-attached session: min(cols) × min(rows) over all subscribers
   * ("smallest subscriber wins"). The terminal must render at this size (letterboxing the slack)
   * instead of its own FitAddon result, or the two viewers' screens diverge.
   * OPTIONAL: a transport that cannot negotiate a shared size (RemoteTransport over the relay,
   * whose frame protocol has no size frame) simply omits it, and the terminal falls back to
   * driving its own FitAddon — today's behavior. Returns an unsubscribe function.
   */
  onSize?(sessionId: string, listener: (size: { cols: number; rows: number }) => void): () => void
  /**
   * Another client permanently DESTROYED this node while we were co-viewing it: the session is
   * gone for good, so the terminal shows a "closed by <peer>" state instead of respawning it.
   * `by` is the destroying client's ClientId (null when no client was attributed — e.g. a local
   * destroy on the desktop); map it to a peer name via the presence store.
   * OPTIONAL for the same reason as onSize. Returns an unsubscribe function.
   */
  onClosed?(sessionId: string, listener: (info: { by: ClientId | null }) => void): () => void
  /**
   * This client fell so far behind that the server discarded its queued output (WS_DROP_WATER)
   * and is redrawing it from tmux: clear the emulator and write this capture — it is the CURRENT
   * screen.
   * CONTRACT: the server only ever emits a NON-EMPTY capture (a failed/empty capture is retried,
   * never sent). The listener must STILL ignore an empty/falsy payload — no reset, no separator:
   * a wrongly reset screen is unrecoverable, a skipped repaint is not.
   * OPTIONAL for the same reason as onSize. Returns an unsubscribe function.
   */
  onResync?(sessionId: string, listener: (screen: string) => void): () => void
}
