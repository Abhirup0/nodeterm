import type { PtyCreateOptions } from '@shared/types'
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

  create(options: PtyCreateOptions): Promise<string> {
    return this.pty.create(options)
  }

  write(sessionId: string, data: string): void {
    this.pty.write(sessionId, data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
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

  onData(sessionId: string, listener: (data: string) => void): () => void {
    return this.pty.onData(sessionId, listener)
  }

  onExit(sessionId: string, listener: (exitCode: number) => void): () => void {
    return this.pty.onExit(sessionId, listener)
  }
}

/** The single transport instance used by the app. Becomes selectable later. */
export const transport: TerminalTransport = new LocalTransport()
