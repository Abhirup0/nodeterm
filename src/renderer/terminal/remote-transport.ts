import type { PtyCreateOptions } from '@shared/types'
import type { TerminalTransport } from './transport'

/**
 * Remote transport: drives a host's PTYs over the relay by binding the IPC API exposed via
 * preload (window.nodeTerminal.remoteClient) to the TerminalTransport interface — the exact
 * shape of LocalTransport, but every call is scoped to a `connectionId` (a relay session
 * established via remoteClient.connect()).
 *
 * `setFlow` and `destroy` are intentionally no-ops: flow control happens host-side (the host
 * pauses/resumes its own PTYs against relay backpressure), and a remote node closing just
 * detaches the client stream via `kill` — the host-side tmux session survives, exactly like
 * LocalTransport's kill/destroy split, but the client never owns the lifecycle of the host's
 * persistent session.
 */
export class RemoteTransport implements TerminalTransport {
  constructor(private readonly connectionId: string) {}

  private get client() {
    return window.nodeTerminal.remoteClient
  }

  create(options: PtyCreateOptions): Promise<string> {
    return this.client.create(this.connectionId, options)
  }

  write(sessionId: string, data: string): void {
    this.client.write(this.connectionId, sessionId, data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.client.resize(this.connectionId, sessionId, cols, rows)
  }

  setFlow(_sessionId: string, _resume: boolean): void {
    // No-op: the host manages flow control on its own PTYs against relay backpressure.
  }

  kill(sessionId: string): void {
    this.client.kill(this.connectionId, sessionId)
  }

  destroy(_persistKey: string): void {
    // No-op: the client doesn't own the host's persistent (tmux) session lifecycle.
  }

  onData(sessionId: string, listener: (data: string) => void): () => void {
    return this.client.onData(this.connectionId, sessionId, listener)
  }

  onExit(sessionId: string, listener: (exitCode: number) => void): () => void {
    return this.client.onExit(this.connectionId, sessionId, listener)
  }
}
