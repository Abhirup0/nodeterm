import type { PtyCreateOptions, PtyCreateResult } from '@shared/types'
import type { ClientId } from '@shared/presence'
import type { TerminalTransport } from './transport'

/**
 * Local transport: binds the IPC API exposed via preload (window.nodeTerminal.pty)
 * to the TerminalTransport interface. All real work happens in node-pty in the main
 * process.
 */
export class LocalTransport implements TerminalTransport {
  private get pty() {
    return window.nodeTerminal.pty
  }

  create(options: PtyCreateOptions): Promise<PtyCreateResult> {
    return this.pty.create(options)
  }

  write(sessionId: string, data: string): void {
    this.pty.write(sessionId, data)
  }

  resize(sessionId: string, cols: number | null, rows: number | null): void {
    this.pty.resize(sessionId, cols, rows)
  }

  setFlow(sessionId: string, resume: boolean): void {
    this.pty.setFlow(sessionId, resume)
  }

  kill(sessionId: string): void {
    this.pty.kill(sessionId)
  }

  destroy(persistKey: string): void {
    this.pty.destroy(persistKey)
  }

  recycle(persistKey: string): void {
    this.pty.recycle(persistKey)
  }

  onData(sessionId: string, listener: (data: string) => void): () => void {
    return this.pty.onData(sessionId, listener)
  }

  onExit(sessionId: string, listener: (exitCode: number) => void): () => void {
    return this.pty.onExit(sessionId, listener)
  }

  onSize(sessionId: string, listener: (size: { cols: number; rows: number }) => void): () => void {
    return this.pty.onSize(sessionId, listener)
  }

  onClosed(sessionId: string, listener: (info: { by: ClientId | null }) => void): () => void {
    return this.pty.onClosed(sessionId, listener)
  }

  onRecycled(sessionId: string, listener: () => void): () => void {
    return this.pty.onRecycled(sessionId, listener)
  }

  onResync(sessionId: string, listener: (screen: string) => void): () => void {
    return this.pty.onResync(sessionId, listener)
  }
}

/** The single transport instance used by the app. Becomes selectable later. */
export const transport: TerminalTransport = new LocalTransport()
